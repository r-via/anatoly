import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel } from '../axis-evaluator.js';
import overengineeringSystemPrompt from './prompts/overengineering.system.md';

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
  return overengineeringSystemPrompt.trimEnd();
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

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<OverengineeringResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
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
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      transcript,
    };
  }
}
