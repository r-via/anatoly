// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel, getCodeFenceTag, getLanguageLines } from '../axis-evaluator.js';
import { getSymbolUsage, getTypeOnlySymbolUsage, getTransitiveUsage } from '../usage-graph.js';
import { resolveSystemPrompt } from '../prompt-resolver.js';
import { formatReclassificationsForAxis } from '../correction-memory.js';
import { BaseSymbolSchema } from '../../schemas/base-symbol.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (utility axis only)
// ---------------------------------------------------------------------------

const UtilitySymbolSchema = BaseSymbolSchema.extend({
  utility: z.enum(['USED', 'DEAD', 'LOW_VALUE']),
});

export const UtilityResponseSchema = z.object({
  symbols: z.array(UtilitySymbolSchema),
});

type UtilityResponse = z.infer<typeof UtilityResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildUtilitySystemPrompt(): string {
  return resolveSystemPrompt('utility');
}

/**
 * Builds the user-message prompt for the utility axis LLM call.
 *
 * Assembles a multi-section Markdown prompt containing the file source,
 * symbols to evaluate, and — when a usage graph is available — a
 * "Pre-computed Import Analysis" section that distinguishes direct imports,
 * type-only imports, and transitive usage for each exported symbol.
 *
 * @param ctx - Axis evaluation context (task, file content, usage graph, etc.)
 * @returns Formatted prompt string ready to send as the user message.
 */
export function buildUtilityUserMessage(ctx: AxisContext): string {
  const parts: string[] = [];

  parts.push(`## File: \`${ctx.task.file}\``);
  parts.push(...getLanguageLines(ctx.task));
  parts.push('');
  parts.push(`\`\`\`${getCodeFenceTag(ctx.task)}`);
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
          const transitiveRefs = getTransitiveUsage(ctx.usageGraph, sym.name, ctx.task.file);
          if (transitiveRefs.length > 0) {
            parts.push(`- ${sym.name} (exported): not directly imported, but TRANSITIVELY USED by ${transitiveRefs.join(', ')} (which ${transitiveRefs.length > 1 ? 'are' : 'is'} imported)`);
          } else {
            parts.push(`- ${sym.name} (exported): imported by 0 files — LIKELY DEAD`);
          }
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
    let userMessage = buildUtilityUserMessage(ctx);

    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'utility');
    if (memorySection) {
      userMessage += '\n' + memorySection;
    }

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<UtilityResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
        conversationDir: ctx.conversationDir,
        conversationPrefix: ctx.conversationDir ? `${ctx.conversationFileSlug}__utility` : undefined,
        semaphore: ctx.semaphore,
        geminiSemaphore: ctx.geminiSemaphore,
        circuitBreaker: ctx.circuitBreaker,
        fallbackModel: ctx.fallbackModel,
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
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      transcript,
    };
  }
}
