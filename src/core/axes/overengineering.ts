// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel, getCodeFenceTag, getLanguageLines } from '../axis-evaluator.js';
import { resolveSystemPrompt } from '../prompt-resolver.js';
import { formatReclassificationsForAxis } from '../correction-memory.js';
import { BaseSymbolSchema } from '../../schemas/base-symbol.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (overengineering axis only)
// ---------------------------------------------------------------------------

const OverengineeringSymbolSchema = BaseSymbolSchema.extend({
  overengineering: z.enum(['LEAN', 'OVER', 'ACCEPTABLE']),
});

/** Zod schema validating the LLM response for the overengineering axis. */
export const OverengineeringResponseSchema = z.object({
  symbols: z.array(OverengineeringSymbolSchema),
});

type OverengineeringResponse = z.infer<typeof OverengineeringResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildOverengineeringSystemPrompt(): string {
  return resolveSystemPrompt('overengineering');
}

/**
 * Builds the user-message prompt for the overengineering axis LLM call.
 *
 * Assembles file content, symbol list, installed dependencies (capped at 40),
 * and project-tree structure with fragmentation-detection heuristics into a
 * Markdown prompt.
 *
 * @param ctx Axis evaluation context with file content, symbols, dependencies, and project tree.
 * @returns The assembled prompt string.
 */
export function buildOverengineeringUserMessage(ctx: AxisContext): string {
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

  if (ctx.fileDeps && ctx.fileDeps.deps.length > 0) {
    const MAX_DEPS = 40;
    const deps = ctx.fileDeps.deps.slice(0, MAX_DEPS);
    parts.push('## Installed Dependencies');
    parts.push('');
    for (const dep of deps) {
      parts.push(`- ${dep.name}: ${dep.version}`);
    }
    if (ctx.fileDeps.deps.length > MAX_DEPS) {
      parts.push(`- ... and ${ctx.fileDeps.deps.length - MAX_DEPS} more`);
    }
    parts.push('');
  }

  parts.push('Evaluate the complexity of each symbol and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

/**
 * Axis evaluator for overengineering detection. Performs a semaphore-guarded
 * LLM query to assess complexity and unnecessary abstraction per symbol,
 * injecting correction-memory reclassifications when available. Defaults to
 * `sonnet` model.
 */
export class OverengineeringEvaluator implements AxisEvaluator {
  readonly id = 'overengineering' as const;
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildOverengineeringSystemPrompt();
    let userMessage = buildOverengineeringUserMessage(ctx);

    const fileSymbols = new Set(ctx.task.symbols.map(s => s.name));
    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'overengineering', fileSymbols);
    if (memorySection) {
      userMessage += '\n' + memorySection;
    }

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<OverengineeringResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
        conversationDir: ctx.conversationDir,
        conversationPrefix: ctx.conversationDir ? `${ctx.conversationFileSlug}__overengineering` : undefined,
        semaphore: ctx.semaphore,
        geminiSemaphore: ctx.geminiSemaphore,
        circuitBreaker: ctx.circuitBreaker,
        fallbackModel: ctx.fallbackModel,
        router: ctx.router,
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
