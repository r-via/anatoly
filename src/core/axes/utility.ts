import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery } from '../axis-evaluator.js';
import { resolveAxisModel } from '../axis-evaluator.js';
import { getSymbolUsage, getTypeOnlySymbolUsage } from '../usage-graph.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (utility axis only)
// ---------------------------------------------------------------------------

const UtilitySymbolSchema = z.object({
  name: z.string(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  utility: z.enum(['USED', 'DEAD', 'LOW_VALUE']),
  confidence: z.int().min(0).max(100),
  detail: z.string().min(10),
});

const UtilityResponseSchema = z.object({
  symbols: z.array(UtilitySymbolSchema),
});

type UtilityResponse = z.infer<typeof UtilityResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildUtilitySystemPrompt(): string {
  return `You are Anatoly, a rigorous TypeScript code auditor focused EXCLUSIVELY on the **utility** axis.

## Your ONLY task

Evaluate whether each symbol is actually USED, DEAD (never imported/called), or LOW_VALUE (used but trivial/unnecessary).

## Rules

1. Use the Pre-computed Import Analysis provided. This data is EXHAUSTIVE — do NOT guess.
2. Exported symbol with 0 runtime importers AND 0 type-only importers = DEAD (confidence: 95).
3. Exported symbol with 1+ runtime importers = USED (confidence: 95).
4. Exported symbol with 0 runtime importers but 1+ type-only importers = USED (confidence: 95). Type-only imports are real usage — removing the symbol would break compilation.
5. Non-exported symbol: check local usage in the file content. If called/referenced = USED, else = DEAD.
6. LOW_VALUE = symbol exists and is used but provides negligible value (e.g. trivial wrapper, identity function).
7. Do NOT evaluate other axes — only utility.

## Output format

Output ONLY a JSON object (no markdown fences, no explanation):

\`\`\`json
{
  "symbols": [
    {
      "name": "symbolName",
      "line_start": 1,
      "line_end": 10,
      "utility": "USED | DEAD | LOW_VALUE",
      "confidence": 95,
      "detail": "Explanation (min 10 chars)"
    }
  ]
}
\`\`\``;
}

export function buildUtilityUserMessage(ctx: AxisContext): string {
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

  if (ctx.usageGraph && ctx.task.symbols.length > 0) {
    parts.push('## Pre-computed Import Analysis');
    parts.push('');
    for (const sym of ctx.task.symbols) {
      if (sym.exported) {
        const importers = getSymbolUsage(ctx.usageGraph, sym.name, ctx.task.file);
        const typeImporters = getTypeOnlySymbolUsage(ctx.usageGraph, sym.name, ctx.task.file);
        if (importers.length === 0 && typeImporters.length === 0) {
          parts.push(`- ${sym.name} (exported): imported by 0 files — LIKELY DEAD`);
        } else if (importers.length > 0) {
          parts.push(`- ${sym.name} (exported): runtime-imported by ${importers.length} file${importers.length > 1 ? 's' : ''}: ${importers.join(', ')}${typeImporters.length > 0 ? ` (also type-imported by ${typeImporters.length})` : ''}`);
        } else {
          parts.push(`- ${sym.name} (exported): type-only imported by ${typeImporters.length} file${typeImporters.length > 1 ? 's' : ''}: ${typeImporters.join(', ')} — USED (type-only)`);
        }
      } else {
        parts.push(`- ${sym.name} (not exported): internal only — check local usage in file`);
      }
    }
    parts.push('');
  }

  parts.push('Evaluate the utility of each symbol and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

export class UtilityEvaluator implements AxisEvaluator {
  readonly id = 'utility' as const;
  readonly defaultModel = 'haiku' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildUtilitySystemPrompt();
    const userMessage = buildUtilityUserMessage(ctx);

    const { data, costUsd, durationMs, transcript } = await runSingleTurnQuery<UtilityResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: '.',
        abortController,
      },
      UtilityResponseSchema,
    );

    const symbols: AxisSymbolResult[] = data.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.utility,
      confidence: s.confidence,
      detail: s.detail,
    }));

    return {
      axisId: 'utility',
      symbols,
      actions: [],
      costUsd,
      durationMs,
      transcript,
    };
  }
}
