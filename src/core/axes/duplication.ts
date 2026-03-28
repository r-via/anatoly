// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel, getCodeFenceTag, getLanguageLines } from '../axis-evaluator.js';
import { contextLogger } from '../../utils/log-context.js';
import { resolveSystemPrompt } from '../prompt-resolver.js';
import { formatReclassificationsForAxis } from '../correction-memory.js';
import { BaseSymbolSchema } from '../../schemas/base-symbol.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (duplication axis only)
// ---------------------------------------------------------------------------

const DuplicateTargetResponseSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  similarity: z.string(),
});

const DuplicationSymbolSchema = BaseSymbolSchema.extend({
  duplication: z.enum(['UNIQUE', 'DUPLICATE']),
  duplicate_target: DuplicateTargetResponseSchema.nullable().optional(),
});

export const DuplicationResponseSchema = z.object({
  symbols: z.array(DuplicationSymbolSchema),
});

type DuplicationResponse = z.infer<typeof DuplicationResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildDuplicationSystemPrompt(): string {
  return resolveSystemPrompt('duplication');
}

/**
 * Builds the user-message prompt for the duplication axis LLM call.
 *
 * The message is a multi-section Markdown string containing:
 * - the file path, language metadata, and full source code;
 * - the list of symbols to evaluate with their line ranges;
 * - a RAG section with semantically similar candidates (including their
 *   source snippets when available), or a fallback instruction to mark
 *   all symbols UNIQUE when no RAG data is present.
 *
 * @param ctx - Axis evaluation context (file content, task, RAG results, etc.).
 * @returns The assembled prompt string ready for the LLM.
 */
export function buildDuplicationUserMessage(ctx: AxisContext): string {
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

  if (ctx.preResolvedRag && ctx.preResolvedRag.length > 0) {
    parts.push('## RAG — Semantic Duplication');
    parts.push('');
    for (const entry of ctx.preResolvedRag) {
      parts.push(`### ${entry.symbolName} (L${entry.lineStart}–L${entry.lineEnd})`);
      if (entry.lineEnd - entry.lineStart <= 1) {
        parts.push('Trivial function (≤ 2 lines). Mark UNIQUE.');
        parts.push('');
        continue;
      }
      if (entry.results === null) {
        parts.push('Function not indexed — cannot check for duplication. Mark UNIQUE.');
      } else if (entry.results.length === 0) {
        parts.push('No similar functions found. Mark UNIQUE.');
      } else {
        parts.push('Similar functions found:');
        for (const r of entry.results) {
          parts.push(`- **${r.card.name}** in \`${r.card.filePath}\` (score: ${r.score.toFixed(3)})`);
          parts.push(`  Signature: ${r.card.signature}`);
          parts.push(`  Complexity: ${r.card.complexityScore}/5`);
          if (r.card.calledInternals.length > 0) {
            parts.push(`  Calls: ${r.card.calledInternals.join(', ')}`);
          }
          // Include candidate source code (up to ~50 lines)
          const candidateSource = readCandidateSource(ctx.projectRoot, r.card.filePath, r.card.name);
          if (candidateSource) {
            parts.push('  Source:');
            parts.push(`  \`\`\`${getCodeFenceTag(ctx.task)}`);
            parts.push(`  ${candidateSource.split('\n').join('\n  ')}`);
            parts.push('  ```');
          }
        }
      }
      parts.push('');
    }
  } else {
    parts.push('## RAG — Semantic Duplication');
    parts.push('');
    parts.push('No RAG data available. Mark all symbols as UNIQUE (confidence: 90).');
    parts.push('');
  }

  parts.push('Evaluate the duplication of each symbol and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_CANDIDATE_LINES = 50;

/**
 * Read candidate function source from disk for code-to-code comparison.
 * Returns null if the file is missing or the function can't be located.
 */
function readCandidateSource(projectRoot: string, filePath: string, functionName: string): string | null {
  try {
    const absPath = resolve(projectRoot, filePath);
    const source = readFileSync(absPath, 'utf-8');
    const lines = source.split('\n');

    // Find the function by name (simple heuristic: first line containing the function name + opening)
    const startIdx = lines.findIndex((line) =>
      line.includes(functionName) && (line.includes('function') || line.includes('=>') || line.includes('('))
    );
    if (startIdx === -1) return null;

    // Extract up to MAX_CANDIDATE_LINES lines
    const snippet = lines.slice(startIdx, startIdx + MAX_CANDIDATE_LINES);
    return snippet.join('\n');
  } catch {
    contextLogger().warn({ filePath, functionName }, 'candidate source file not found on disk');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto-resolution (skip LLM when no RAG candidates exist)
// ---------------------------------------------------------------------------

/**
 * Check whether any symbol in the file has RAG similarity candidates that
 * require LLM comparison. Returns false when all symbols can be trivially
 * marked UNIQUE (no RAG data, no candidates, or trivial functions).
 */
function fileHasSimilarityCandidates(ctx: AxisContext): boolean {
  if (!ctx.preResolvedRag || ctx.preResolvedRag.length === 0) return false;
  return ctx.preResolvedRag.some(
    (entry) =>
      entry.lineEnd - entry.lineStart > 1 &&
      entry.results !== null &&
      entry.results.length > 0,
  );
}

/**
 * Build auto-resolved UNIQUE verdicts for all symbols in a file.
 * Used when no symbol has RAG similarity candidates.
 */
function buildAutoUniqueResults(ctx: AxisContext): AxisSymbolResult[] {
  return ctx.task.symbols.map((sym) => {
    let detail = 'No similar functions found in codebase';
    if (!ctx.preResolvedRag || ctx.preResolvedRag.length === 0) {
      detail = 'No RAG data available';
    } else {
      const entry = ctx.preResolvedRag.find(
        (e) => e.symbolName === sym.name,
      );
      if (entry && entry.lineEnd - entry.lineStart <= 1) {
        detail = 'Trivial function (≤ 2 lines)';
      }
    }
    return {
      name: sym.name,
      line_start: sym.line_start,
      line_end: sym.line_end,
      value: 'UNIQUE',
      confidence: 90,
      detail,
    };
  });
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

/**
 * Axis evaluator for duplication detection.
 *
 * Classifies each symbol in a file as `UNIQUE` or `DUPLICATE` by sending
 * the source code together with RAG-retrieved similar candidates to an LLM,
 * then parsing the structured response against {@link DuplicationResponseSchema}.
 * Implements the {@link AxisEvaluator} interface with `id = 'duplication'` and
 * a default model of `'haiku'`.
 */
export class DuplicationEvaluator implements AxisEvaluator {
  readonly id = 'duplication' as const;
  readonly defaultModel = 'haiku' as const;
  readonly defaultGeminiMode = 'flash' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    // --- Skip LLM when no symbol has similarity candidates ---
    if (!fileHasSimilarityCandidates(ctx)) {
      return {
        axisId: 'duplication',
        symbols: buildAutoUniqueResults(ctx),
        actions: [],
        costUsd: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        transcript: '',
      };
    }

    // --- At least one symbol has candidates — full LLM evaluation ---
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildDuplicationSystemPrompt();
    let userMessage = buildDuplicationUserMessage(ctx);

    const fileSymbols = new Set(ctx.task.symbols.map(s => s.name));
    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'duplication', fileSymbols);
    if (memorySection) {
      userMessage += '\n' + memorySection;
    }

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<DuplicationResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
        conversationDir: ctx.conversationDir,
        conversationPrefix: ctx.conversationDir ? `${ctx.conversationFileSlug}__duplication` : undefined,
        semaphore: ctx.semaphore,
        geminiSemaphore: ctx.geminiSemaphore,
        circuitBreaker: ctx.circuitBreaker,
        fallbackModel: ctx.fallbackModel,
      },
      DuplicationResponseSchema,
    );

    const symbols: AxisSymbolResult[] = data.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.duplication,
      confidence: s.confidence,
      detail: s.detail,
      duplicate_target: s.duplicate_target ?? undefined,
    }));

    return {
      axisId: 'duplication',
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
