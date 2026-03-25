// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel, getCodeFenceTag, getLanguageLines } from '../axis-evaluator.js';
import type { Action } from '../../schemas/review.js';
import { extractRelevantReadmeSections } from '../dependency-meta.js';
import { resolveSystemPrompt } from '../prompt-resolver.js';
import { formatReclassificationsForAxis, recordReclassification } from '../correction-memory.js';
import { BaseSymbolSchema } from '../../schemas/base-symbol.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (correction axis only)
// ---------------------------------------------------------------------------

const CorrectionSymbolSchema = BaseSymbolSchema.extend({
  correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
});

const CorrectionActionSchema = z.object({
  description: z.string(),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  line: z.int().min(1).optional(),
});

/** Zod schema for the structured LLM response from the correction axis evaluation. */
export const CorrectionResponseSchema = z.object({
  symbols: z.array(CorrectionSymbolSchema),
  actions: z.array(CorrectionActionSchema).default([]),
});

type CorrectionResponse = z.infer<typeof CorrectionResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/** Builds the system prompt for the correction axis LLM call. */
export function buildCorrectionSystemPrompt(): string {
  return resolveSystemPrompt('correction');
}

/** Assembles the user message for the correction axis, including source code and symbol list. */
export function buildCorrectionUserMessage(ctx: AxisContext): string {
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
// Verification pass (two-pass correction)
// ---------------------------------------------------------------------------

const VerificationSymbolSchema = z.object({
  name: z.string(),
  original_correction: z.enum(['NEEDS_FIX', 'ERROR']),
  verified_correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
  confidence: z.int().min(0).max(100),
  reason: z.string().min(10),
});

/** Zod schema for the second-pass verification response that confirms or rejects initial correction findings. */
export const VerificationResponseSchema = z.object({
  symbols: z.array(VerificationSymbolSchema),
});

type VerificationResponse = z.infer<typeof VerificationResponseSchema>;

function buildVerificationSystemPrompt(): string {
  return resolveSystemPrompt('correction.verification');
}

const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'will', 'would',
  'could', 'should', 'does', 'which', 'when', 'where',
  'they', 'them', 'their', 'there', 'about', 'into', 'more',
  'some', 'such', 'than', 'very', 'also', 'just', 'only',
  'each', 'because', 'being', 'other', 'what', 'then', 'still',
  'called', 'calls', 'like', 'used', 'using', 'before', 'after',
]);

/**
 * Extract search keywords from correction findings for README section targeting.
 * Tokenizes detail text from NEEDS_FIX/ERROR symbols, filters stop words and short tokens,
 * and returns a deduplicated keyword list.
 * @param findings - The correction LLM response containing per-symbol results.
 * @returns Unique lowercase keywords (>3 chars, stop words excluded) for README search.
 */
export function extractVerificationKeywords(
  findings: CorrectionResponse,
): string[] {
  const keywords = new Set<string>();

  for (const sym of findings.symbols) {
    if (sym.correction !== 'NEEDS_FIX' && sym.correction !== 'ERROR') continue;

    const tokens = sym.detail
      .toLowerCase()
      .split(/[\s,.:;()\[\]{}'"`\/\\|—–]+/)
      .filter((t) => t.length > 3)
      .filter((t) => !STOP_WORDS.has(t));

    for (const token of tokens) {
      keywords.add(token);
    }
  }

  return [...keywords];
}

function buildVerificationUserMessage(
  findings: CorrectionResponse,
  ctx: AxisContext,
): string {
  const parts: string[] = [];
  const keywords = extractVerificationKeywords(findings);

  // Include the flagged findings
  const flagged = findings.symbols.filter(
    (s) => s.correction === 'NEEDS_FIX' || s.correction === 'ERROR',
  );

  parts.push('## Findings to verify');
  parts.push('');
  for (const s of flagged) {
    parts.push(`### \`${s.name}\` — ${s.correction} (confidence: ${s.confidence}%)`);
    parts.push(`Detail: ${s.detail}`);
    parts.push('');
  }

  // Include original source code for reference
  parts.push(`## Source: \`${ctx.task.file}\``);
  parts.push('');
  parts.push(`\`\`\`${getCodeFenceTag(ctx.task)}`);
  parts.push(ctx.fileContent);
  parts.push('```');
  parts.push('');

  // Include README documentation for each dependency (targeted extraction)
  if (ctx.fileDeps && ctx.fileDeps.deps.length > 0) {
    parts.push('## Library Documentation');
    parts.push('');
    for (const dep of ctx.fileDeps.deps) {
      const readme = extractRelevantReadmeSections(ctx.projectRoot, dep.name, keywords);
      if (readme) {
        parts.push(`### ${dep.name}@${dep.version}`);
        parts.push('');
        parts.push(readme);
        parts.push('');
      }
    }
  }

  parts.push('Verify each finding against the documentation and output the JSON.');

  return parts.join('\n');
}

/**
 * Returns true when pass-2 verification should run: requires both file-level
 * dependency info and at least one NEEDS_FIX or ERROR symbol in the findings.
 */
function findingsNeedVerification(
  findings: CorrectionResponse,
  ctx: AxisContext,
): boolean {
  if (!ctx.fileDeps || ctx.fileDeps.deps.length === 0) return false;

  return findings.symbols.some(
    (s) => s.correction === 'NEEDS_FIX' || s.correction === 'ERROR',
  );
}

/**
 * Apply verification results: override pass 1 findings with pass 2 verdicts.
 * Records false positives in the correction memory for future runs.
 */
function applyVerification(
  pass1: CorrectionResponse,
  verification: VerificationResponse,
  ctx: AxisContext,
): CorrectionResponse {
  const verifiedMap = new Map(
    verification.symbols.map((v) => [v.name, v]),
  );

  const updatedSymbols = pass1.symbols.map((sym) => {
    const v = verifiedMap.get(sym.name);
    if (!v) return sym;

    // If verification changed the verdict (e.g. NEEDS_FIX → OK)
    if (v.verified_correction !== v.original_correction) {
      // Record as false positive for future runs
      const depName = detectImplicatedDep(sym.detail, ctx.fileDeps);
      recordReclassification(ctx.projectRoot, {
        pattern: summarizePattern(sym.detail),
        axis: 'correction',
        dependency: depName,
        original_detail: sym.detail,
        reason: v.reason,
      });

      return {
        ...sym,
        correction: v.verified_correction as 'OK' | 'NEEDS_FIX' | 'ERROR',
        confidence: v.confidence,
        detail: `${v.reason} (verified against documentation)`,
      };
    }

    // Verification confirmed the finding — update confidence
    return { ...sym, confidence: v.confidence };
  });

  // Remove actions whose line falls within a now-OK symbol's range
  const okRanges = updatedSymbols
    .filter((s) => s.correction === 'OK')
    .map((s) => ({ start: s.line_start, end: s.line_end }));

  const filteredActions = pass1.actions.filter((a) => {
    if (!a.line) return true; // No line info → keep conservatively
    return !okRanges.some((r) => a.line! >= r.start && a.line! <= r.end);
  });

  return { symbols: updatedSymbols, actions: filteredActions };
}

/**
 * Detect which dependency is implicated in a finding detail.
 */
function detectImplicatedDep(
  detail: string,
  fileDeps?: { deps: Array<{ name: string; version: string }> },
): string | undefined {
  if (!fileDeps) return undefined;
  const lower = detail.toLowerCase();
  for (const dep of fileDeps.deps) {
    if (lower.includes(dep.name.toLowerCase())) return dep.name;
  }
  return undefined;
}

/**
 * Summarize a finding detail into a short pattern string for memory deduplication.
 */
function summarizePattern(detail: string): string {
  // Take the first sentence or first 100 chars
  const firstSentence = detail.split(/\.\s/)[0];
  return firstSentence.length > 120
    ? firstSentence.slice(0, 120) + '...'
    : firstSentence;
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

/** Evaluator that detects bugs and logic errors using a two-pass LLM strategy (initial scan + verification). */
export class CorrectionEvaluator implements AxisEvaluator {
  readonly id = 'correction' as const;
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildCorrectionSystemPrompt();
    let userMessage = buildCorrectionUserMessage(ctx);

    // Inject known false positives from memory into the prompt
    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'correction');
    if (memorySection) {
      userMessage += '\n' + memorySection;
    }

    // --- Pass 1: standard correction ---
    const pass1 = await runSingleTurnQuery<CorrectionResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
        conversationDir: ctx.conversationDir,
        conversationPrefix: ctx.conversationDir ? `${ctx.conversationFileSlug}__correction` : undefined,
        semaphore: ctx.semaphore,
      },
      CorrectionResponseSchema,
    );

    let finalData = pass1.data;
    let totalCost = pass1.costUsd;
    let totalDuration = pass1.durationMs;
    let totalInputTokens = pass1.inputTokens;
    let totalOutputTokens = pass1.outputTokens;
    let totalCacheReadTokens = pass1.cacheReadTokens;
    let totalCacheCreationTokens = pass1.cacheCreationTokens;
    let transcript = pass1.transcript;

    // --- Pass 2: verify dependency-related findings against README ---
    if (findingsNeedVerification(pass1.data, ctx)) {
      try {
        const verifyPrompt = buildVerificationSystemPrompt();
        const verifyMessage = buildVerificationUserMessage(pass1.data, ctx);

        const pass2 = await runSingleTurnQuery<VerificationResponse>(
          {
            systemPrompt: verifyPrompt,
            userMessage: verifyMessage,
            model,
            projectRoot: ctx.projectRoot,
            abortController,
            conversationDir: ctx.conversationDir,
            conversationPrefix: ctx.conversationDir ? `${ctx.conversationFileSlug}__correction-verify` : undefined,
            semaphore: ctx.semaphore,
          },
          VerificationResponseSchema,
        );

        totalCost += pass2.costUsd;
        totalDuration += pass2.durationMs;
        totalInputTokens += pass2.inputTokens;
        totalOutputTokens += pass2.outputTokens;
        totalCacheReadTokens += pass2.cacheReadTokens;
        totalCacheCreationTokens += pass2.cacheCreationTokens;
        transcript += '\n\n---\n\n## Verification Pass\n\n' + pass2.transcript;

        // Apply verification results to pass 1 data
        finalData = applyVerification(pass1.data, pass2.data, ctx);
      } catch {
        // Verification pass failed — keep pass 1 results as-is
        transcript += '\n\n---\n\n## Verification Pass — FAILED (keeping pass 1 results)\n';
      }
    }

    const symbols: AxisSymbolResult[] = finalData.symbols.map((s) => ({
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

    const actions: Action[] = finalData.actions.map((a, i) => ({
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
      costUsd: totalCost,
      durationMs: totalDuration,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
      transcript,
    };
  }
}
