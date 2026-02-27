import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery } from '../axis-evaluator.js';
import { resolveAxisModel } from '../axis-evaluator.js';
import { getSymbolUsage, getTypeOnlySymbolUsage } from '../usage-graph.js';
import utilitySystemPrompt from './prompts/utility.system.md';

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
  return utilitySystemPrompt.trimEnd();
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
        projectRoot: ctx.projectRoot,
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
