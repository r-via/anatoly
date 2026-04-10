// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel, getCodeFenceTag, getLanguageLines } from '../axis-evaluator.js';
import { getSymbolUsage, getTypeOnlySymbolUsage, getTransitiveUsage } from '../usage-graph.js';
import { resolveSystemPrompt } from '../prompt-resolver.js';
import { formatReclassificationsForAxis } from '../correction-memory.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (utility axis only)
//
// Uses a token-optimized format: structured JSON evidence fields + an
// optional telegraphic note. The prose `detail` field common to other axes
// is replaced here by `evidence` + `note`, then serialized back to a terse
// `detail` string before entering the merger.
// ---------------------------------------------------------------------------

const UtilityEvidenceSchema = z.object({
  runtime_importers: z.int().min(0),
  type_importers: z.int().min(0),
  local_refs: z.int().min(0),
  transitive: z.boolean(),
  exported: z.boolean(),
});

type UtilityEvidence = z.infer<typeof UtilityEvidenceSchema>;

const UtilitySymbolSchema = z.object({
  name: z.string(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  utility: z.enum(['USED', 'DEAD', 'LOW_VALUE']),
  confidence: z.int().min(0).max(100),
  evidence: UtilityEvidenceSchema,
  note: z.string(),
});

export const UtilityResponseSchema = z.object({
  symbols: z.array(UtilitySymbolSchema),
});

type UtilityResponse = z.infer<typeof UtilityResponseSchema>;

/**
 * Serialize structured utility evidence + telegraphic note into a terse
 * detail string compatible with the downstream pipe-delimited format used
 * by the axis merger, reporter, and review writer.
 *
 * Keeps the downstream contract unchanged: consumers still receive a string,
 * but it is significantly shorter than the previous prose format.
 *
 * @param evidence - The structured evidence fields from the LLM response.
 * @param note - Optional telegraphic note (empty for clear USED verdicts).
 * @returns A terse period-separated string (e.g. "0 importers. exported.").
 */
export function serializeUtilityDetail(evidence: UtilityEvidence, note: string): string {
  const parts: string[] = [];

  if (evidence.exported) {
    if (evidence.runtime_importers > 0) {
      parts.push(`${evidence.runtime_importers} runtime imp`);
    }
    if (evidence.type_importers > 0) {
      parts.push(`${evidence.type_importers} type imp`);
    }
    if (evidence.runtime_importers === 0 && evidence.type_importers === 0) {
      parts.push('0 importers');
    }
  } else {
    parts.push(`${evidence.local_refs} local refs`);
  }

  if (evidence.transitive) parts.push('transitive');

  const trimmedNote = note.trim();
  if (trimmedNote) parts.push(trimmedNote);

  return parts.join('. ') || 'no evidence';
}

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
// Auto-resolution (skip LLM for trivially resolvable symbols)
// ---------------------------------------------------------------------------

type AutoVerdict = { value: 'USED' | 'DEAD'; confidence: number; detail: string } | null;

/**
 * Attempt to resolve a symbol's utility verdict purely from the usage graph,
 * without calling the LLM.
 *
 * Returns a verdict for symbols that are unambiguously USED (runtime/type/transitive
 * importers) or DEAD (exported with 0 importers of any kind). Returns null for
 * non-exported symbols that require local code analysis.
 */
function autoResolveSymbol(
  sym: { name: string; exported: boolean },
  ctx: AxisContext,
): AutoVerdict {
  if (!ctx.usageGraph || !sym.exported) return null;

  const importers = getSymbolUsage(ctx.usageGraph, sym.name, ctx.task.file);
  const typeImporters = getTypeOnlySymbolUsage(ctx.usageGraph, sym.name, ctx.task.file);

  if (importers.length > 0) {
    return {
      value: 'USED',
      confidence: 95,
      detail: serializeUtilityDetail(
        {
          runtime_importers: importers.length,
          type_importers: typeImporters.length,
          local_refs: 0,
          transitive: false,
          exported: true,
        },
        '',
      ),
    };
  }

  if (typeImporters.length > 0) {
    return {
      value: 'USED',
      confidence: 95,
      detail: serializeUtilityDetail(
        {
          runtime_importers: 0,
          type_importers: typeImporters.length,
          local_refs: 0,
          transitive: false,
          exported: true,
        },
        '',
      ),
    };
  }

  const transitiveRefs = getTransitiveUsage(ctx.usageGraph, sym.name, ctx.task.file);
  if (transitiveRefs.length > 0) {
    return {
      value: 'USED',
      confidence: 95,
      detail: serializeUtilityDetail(
        {
          runtime_importers: 0,
          type_importers: 0,
          local_refs: 0,
          transitive: true,
          exported: true,
        },
        `via ${transitiveRefs.join(', ')}`,
      ),
    };
  }

  // Exported with 0 importers of any kind → DEAD
  return {
    value: 'DEAD',
    confidence: 95,
    detail: serializeUtilityDetail(
      {
        runtime_importers: 0,
        type_importers: 0,
        local_refs: 0,
        transitive: false,
        exported: true,
      },
      'exported. no consumers.',
    ),
  };
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

export class UtilityEvaluator implements AxisEvaluator {
  readonly id = 'utility' as const;
  readonly defaultModel = 'haiku' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    // --- Phase 1: auto-resolve trivially deterministic symbols ---
    const autoResults: AxisSymbolResult[] = [];
    let needsLlm = false;

    for (const sym of ctx.task.symbols) {
      const auto = autoResolveSymbol(sym, ctx);
      if (auto) {
        autoResults.push({
          name: sym.name,
          line_start: sym.line_start,
          line_end: sym.line_end,
          value: auto.value,
          confidence: auto.confidence,
          detail: auto.detail,
        });
      } else {
        needsLlm = true;
      }
    }

    // All symbols auto-resolved → skip LLM entirely
    if (!needsLlm) {
      return {
        axisId: 'utility',
        symbols: autoResults,
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

    // --- Phase 2: at least one symbol needs LLM — send the full file ---
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildUtilitySystemPrompt();
    let userMessage = buildUtilityUserMessage(ctx);

    const fileSymbols = new Set(ctx.task.symbols.map(s => s.name));
    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'utility', fileSymbols);
    if (memorySection) {
      userMessage += '\n' + memorySection;
    }

    // Build a refined schema that checks the LLM returned all non-auto-resolved symbols
    const autoResolvedNames = new Set(autoResults.map(a => a.name));
    const requiredLlmNames = ctx.task.symbols
      .map(s => s.name)
      .filter(n => !autoResolvedNames.has(n));

    const refinedSchema = UtilityResponseSchema.refine(
      (data) => {
        const returned = new Set(data.symbols.map(s => s.name));
        return requiredLlmNames.every(n => returned.has(n));
      },
      `Missing required symbols in response. You must include ALL of these symbols: ${requiredLlmNames.join(', ')}`,
    );

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<UtilityResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
        conversationDir: ctx.conversationDir,
        conversationPrefix: ctx.conversationDir ? `${ctx.conversationFileSlug}__utility` : undefined,
        router: ctx.router,
        userInstructions: ctx.userInstructions?.forAxis('utility'),
      },
      refinedSchema,
    );

    const llmSymbols: AxisSymbolResult[] = data.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.utility,
      confidence: s.confidence,
      detail: serializeUtilityDetail(s.evidence, s.note),
    }));

    // Merge: LLM results take precedence, auto-results fill in the rest
    const llmByName = new Map(llmSymbols.map(s => [s.name, s]));
    const merged: AxisSymbolResult[] = ctx.task.symbols.map(sym => {
      return llmByName.get(sym.name) ?? autoResults.find(a => a.name === sym.name)!;
    });

    return {
      axisId: 'utility',
      symbols: merged,
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
