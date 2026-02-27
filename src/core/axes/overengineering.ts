import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel } from '../axis-evaluator.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (overengineering axis only)
// ---------------------------------------------------------------------------

const OverengineeringSymbolSchema = z.object({
  name: z.string(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  overengineering: z.enum(['LEAN', 'OVER', 'ACCEPTABLE']),
  confidence: z.int().min(0).max(100),
  detail: z.string().min(10),
});

const OverengineeringResponseSchema = z.object({
  symbols: z.array(OverengineeringSymbolSchema),
});

type OverengineeringResponse = z.infer<typeof OverengineeringResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildOverengineeringSystemPrompt(): string {
  return `You are Anatoly, a rigorous TypeScript code auditor focused EXCLUSIVELY on the **overengineering** axis.

## Your ONLY task

Evaluate whether each symbol is LEAN (appropriately complex), OVER (unnecessarily complex, premature abstraction), or ACCEPTABLE (slightly complex but justified).

## Rules

1. LEAN = implementation is minimal and appropriate for its purpose (confidence: 90+).
2. OVER = unnecessary abstractions, premature generalization, overly complex patterns for a simple task (confidence: 80+).
3. ACCEPTABLE = some complexity but justified by requirements (confidence: 85+).
4. Signs of overengineering: unnecessary generics, factory patterns for single use, deep inheritance hierarchies, abstract classes with single implementation, excessive configuration for simple behavior.
5. A function doing one thing well is LEAN, even if it's long.
6. Do NOT evaluate other axes — only overengineering.

## Output format

Output ONLY a JSON object (no markdown fences, no explanation):

\`\`\`json
{
  "symbols": [
    {
      "name": "symbolName",
      "line_start": 1,
      "line_end": 10,
      "overengineering": "LEAN | OVER | ACCEPTABLE",
      "confidence": 95,
      "detail": "Explanation (min 10 chars)"
    }
  ]
}
\`\`\``;
}

export function buildOverengineeringUserMessage(ctx: AxisContext): string {
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

  if (ctx.projectTree) {
    parts.push('## Project Structure');
    parts.push('');
    parts.push('```');
    parts.push(ctx.projectTree);
    parts.push('```');
    parts.push('');
    parts.push('Use the project structure to detect excessive fragmentation:');
    parts.push('- Directory with only 1 file → potential fragmentation');
    parts.push('- More than 5 nesting levels → excessive structural complexity');
    parts.push('- Factory/adapter directories with ≤ 2 files → likely over-engineering');
    parts.push('These heuristics may increase a symbol\'s rating from LEAN to OVER.');
    parts.push('');
  }

  parts.push('Evaluate the complexity of each symbol and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

export class OverengineeringEvaluator implements AxisEvaluator {
  readonly id = 'overengineering' as const;
  readonly defaultModel = 'haiku' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildOverengineeringSystemPrompt();
    const userMessage = buildOverengineeringUserMessage(ctx);

    const { data, costUsd, durationMs, transcript } = await runSingleTurnQuery<OverengineeringResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: '.',
        abortController,
      },
      OverengineeringResponseSchema,
    );

    const symbols: AxisSymbolResult[] = data.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.overengineering,
      confidence: s.confidence,
      detail: s.detail,
    }));

    return {
      axisId: 'overengineering',
      symbols,
      actions: [],
      costUsd,
      durationMs,
      transcript,
    };
  }
}
