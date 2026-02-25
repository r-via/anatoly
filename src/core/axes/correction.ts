import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel } from '../axis-evaluator.js';
import type { Action } from '../../schemas/review.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (correction axis only)
// ---------------------------------------------------------------------------

const CorrectionSymbolSchema = z.object({
  name: z.string(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
  confidence: z.int().min(0).max(100),
  detail: z.string().min(10),
});

const CorrectionActionSchema = z.object({
  description: z.string(),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  line: z.int().min(1).optional(),
});

const CorrectionResponseSchema = z.object({
  symbols: z.array(CorrectionSymbolSchema),
  actions: z.array(CorrectionActionSchema).default([]),
});

type CorrectionResponse = z.infer<typeof CorrectionResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildCorrectionSystemPrompt(): string {
  return `You are Anatoly, a rigorous TypeScript code auditor focused EXCLUSIVELY on the **correction** axis.

## Your ONLY task

Identify bugs, logic errors, incorrect types, unsafe operations, and missing error handling in each symbol.

## Rules

1. OK = no bugs or correctness issues found (confidence: 90+).
2. NEEDS_FIX = a real bug, logic error, or type mismatch that would cause incorrect behavior at runtime (confidence: 80+).
3. ERROR = a critical bug that would cause a crash or data loss (confidence: 90+).
4. Do NOT flag style issues, naming conventions, or performance — only correctness.
5. Do NOT flag missing tests — only actual bugs in the implementation.
6. For each NEEDS_FIX or ERROR, add an action with severity and description.
7. Do NOT evaluate other axes — only correction.
8. When project dependency versions are provided, consider them when evaluating correctness. Do not flag as a bug something that is handled natively by the installed version of a dependency.

## Output format

Output ONLY a JSON object (no markdown fences, no explanation):

\`\`\`json
{
  "symbols": [
    {
      "name": "symbolName",
      "line_start": 1,
      "line_end": 10,
      "correction": "OK | NEEDS_FIX | ERROR",
      "confidence": 95,
      "detail": "Explanation (min 10 chars)"
    }
  ],
  "actions": [
    {
      "description": "Fix description",
      "severity": "CRITICAL | MAJOR | MINOR",
      "line": 5
    }
  ]
}
\`\`\``;
}

export function buildCorrectionUserMessage(ctx: AxisContext): string {
  const parts: string[] = [];

  parts.push(`## File: \`${ctx.task.file}\``);
  parts.push('');
  parts.push('```typescript');
  parts.push(ctx.fileContent);
  parts.push('```');
  parts.push('');

  parts.push('## Symbols to evaluate');
  parts.push('');
  for (const s of ctx.task.symbols) {
    parts.push(`- ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (L${s.line_start}–L${s.line_end})`);
  }
  parts.push('');

  if (ctx.fileDeps && ctx.fileDeps.deps.length > 0) {
    parts.push('## Project Dependencies (imported in this file)');
    parts.push('');
    for (const dep of ctx.fileDeps.deps) {
      parts.push(`- ${dep.name}: ${dep.version}`);
    }
    if (ctx.fileDeps.nodeEngine) {
      parts.push(`- Node.js engine: ${ctx.fileDeps.nodeEngine}`);
    }
    parts.push('');
  }

  parts.push('Identify any bugs, logic errors, or correctness issues and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

export class CorrectionEvaluator implements AxisEvaluator {
  readonly id = 'correction' as const;
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildCorrectionSystemPrompt();
    const userMessage = buildCorrectionUserMessage(ctx);

    const { data, costUsd, durationMs, transcript } = await runSingleTurnQuery<CorrectionResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: '.',
        abortController,
      },
      CorrectionResponseSchema,
    );

    const symbols: AxisSymbolResult[] = data.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.correction,
      confidence: s.confidence,
      detail: s.detail,
    }));

    const severityMap: Record<string, 'high' | 'medium' | 'low'> = {
      CRITICAL: 'high',
      MAJOR: 'medium',
      MINOR: 'low',
    };

    const actions: Action[] = data.actions.map((a, i) => ({
      id: i + 1,
      description: a.description,
      severity: severityMap[a.severity] ?? 'medium',
      effort: 'small' as const,
      category: 'quickwin' as const,
      target_symbol: null,
      target_lines: a.line ? `L${a.line}` : null,
    }));

    return {
      axisId: 'correction',
      symbols,
      actions,
      costUsd,
      durationMs,
      transcript,
    };
  }
}
