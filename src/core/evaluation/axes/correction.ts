// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../contract.js';
import { runSingleTurnQuery, resolveAxisModel, getCodeFenceTag, getLanguageLines } from '../evaluator.js';
import type { Action } from '../../../schemas/review.js';
import { extractRelevantReadmeSections } from '../../scanning/index.js';
import { resolveSystemPrompt } from '../../platform/index.js';
import { formatReclassificationsForAxis, recordReclassification } from '../../platform/index.js';
import { BaseSymbolSchema } from '../../../schemas/base-symbol.js';
import { DocDivergenceSchema } from '../../../schemas/review.js';
import { renderInternalDocsContext } from './internal-docs-context.js';
import { renderReferenceDocsContext } from './reference-docs-context.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (correction axis only)
// ---------------------------------------------------------------------------

/**
 * One distinct defect on a symbol. Use the `findings` array on
 * `CorrectionSymbolSchema` when a single symbol carries several
 * independent issues (e.g. a function with both a wrong-sign
 * multiplier and a Math.ceil rounding bug).
 */
const CorrectionFindingSchema = z.object({
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  detail: z.string().min(10),
});

const CorrectionSymbolSchema = BaseSymbolSchema.extend({
  correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
  /**
   * Optional list of distinct defects on this symbol. Leave empty for
   * OK symbols or single-defect symbols (use the top-level `detail`).
   * Populate with one entry per independent defect when the symbol
   * carries several — they will surface as separate rows in the
   * markdown report and as separate findings in downstream consumers
   * (e.g. anatoly-bench).
   */
  findings: z.array(CorrectionFindingSchema).optional(),
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
  /** Doc divergence findings when reference docs contradict code (Story 54.9, FR15). */
  doc_divergences: z.array(DocDivergenceSchema).optional(),
});

export type CorrectionResponse = z.infer<typeof CorrectionResponseSchema>;

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

  const referenceDocsSection = renderReferenceDocsContext(ctx.referenceDocs, ctx.arbitratedFragments);
  if (referenceDocsSection) {
    parts.push(referenceDocsSection);
  }

  const internalDocsSection = renderInternalDocsContext(ctx.relevantDocs, ctx.config);
  if (internalDocsSection) {
    parts.push(internalDocsSection);
  }

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

export type VerificationResponse = z.infer<typeof VerificationResponseSchema>;

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
 * Apply verification results: override pass-1 findings with pass-2 verdicts.
 * Records false positives in the correction memory for future runs and filters
 * out actions whose lines fall within symbols reclassified to OK.
 */
export function applyVerification(
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
        symbol: sym.name,
        reclassifications: [{ axis: 'correction', from: v.original_correction, to: v.verified_correction }],
        dependency: depName,
        original_detail: sym.detail,
        reason: v.reason,
      });

      return {
        ...sym,
        correction: v.verified_correction as 'OK' | 'NEEDS_FIX' | 'ERROR',
        confidence: v.confidence,
        detail: `${v.reason} (verified against documentation)`,
        // The per-defect findings belong to the pre-verification verdict; once
        // the symbol is reclassified they no longer apply and must not be
        // carried over by the `...sym` spread (else an OK symbol still exposes
        // stale error findings to the reporter and bench scorer).
        findings: undefined,
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

  return { symbols: updatedSymbols, actions: filteredActions, doc_divergences: pass1.doc_divergences };
}

/**
 * Conclusion-shaped phrases that mean "after analysis, the code is correct".
 * Tight on purpose: each is a verdict-level conclusion, not a hedge. Bare
 * softeners ("this is fine", "harmless") are excluded to avoid suppressing a
 * real bug that merely contains reassuring prose. Extend with care.
 */
const SELF_EXONERATION =
  /\b(no bug here|not (a |an )?(real |actual )?bug\b|isn'?t (a |an )?bug\b|no (real|actual) (bug|issue|problem|defect)|not actually (a |an )?(bug|issue|problem|defect)|accidentally works|semantics rescue)/i;

function isSelfExonerating(text: string | undefined): boolean {
  return !!text && SELF_EXONERATION.test(text);
}

/**
 * Deterministic coherence guard: reconcile a flagged verdict with its own
 * evidence. The LLM occasionally emits `NEEDS_FIX`/`ERROR` while its `detail`
 * or `findings` reason their way to "no bug here" (e.g. `resolveCliBinName`,
 * run 2026-06-04). Prompt rule 13 forbids this, but this is the safety net:
 *
 *  - drop any individual finding whose text exonerates the code;
 *  - if EVERY backing finding exonerated (or, for a single-defect symbol with
 *    no findings, the `detail` itself exonerates), the verdict is unsupported
 *    by its own analysis → downgrade the symbol to `OK`.
 *
 * Conservative by construction: a symbol keeps `NEEDS_FIX` as long as one real
 * (non-exonerating) finding remains, so a mixed symbol never loses its bug.
 * Actions anchored inside a downgraded symbol are dropped, mirroring
 * {@link applyVerification}.
 */
export function reconcileSelfContradictions(data: CorrectionResponse): CorrectionResponse {
  const downgraded: Array<{ start: number; end: number }> = [];

  const symbols = data.symbols.map((sym) => {
    if (sym.correction !== 'NEEDS_FIX' && sym.correction !== 'ERROR') return sym;

    const findings = sym.findings ?? [];
    if (findings.length > 0) {
      const kept = findings.filter((f) => !isSelfExonerating(f.detail));
      if (kept.length === 0) {
        // Every backing finding cleared the code — verdict is unsupported.
        downgraded.push({ start: sym.line_start, end: sym.line_end });
        return {
          ...sym,
          correction: 'OK' as const,
          detail: `${sym.detail} (reconciled to OK: the finding's own analysis concludes there is no defect)`,
          findings: undefined,
        };
      }
      if (kept.length !== findings.length) {
        return { ...sym, findings: kept };
      }
      return sym;
    }

    // Single-defect symbol carried only by `detail`.
    if (isSelfExonerating(sym.detail)) {
      downgraded.push({ start: sym.line_start, end: sym.line_end });
      return {
        ...sym,
        correction: 'OK' as const,
        detail: `${sym.detail} (reconciled to OK: the analysis concludes there is no defect)`,
      };
    }
    return sym;
  });

  if (downgraded.length === 0) return { ...data, symbols };

  const actions = data.actions.filter((a) => {
    if (!a.line) return true;
    return !downgraded.some((r) => a.line! >= r.start && a.line! <= r.end);
  });
  return { ...data, symbols, actions };
}

/**
 * Remediation VERB that turns an unused symbol into live code: export it,
 * re-export it, wire it up, or "make it used/reachable/callable". Matched on
 * the proposed fix, not on any justification.
 */
const RESURRECTION_VERB =
  /\b(re-?export|exports?|exporting|exported|wire(?:\s|-)?(?:it|them|this)?\s*up|make\s+(?:it|them|this)\s+(?:used|reachable|callable|live|active))\b/i;

/**
 * Explicit deadness justification: the action admits the symbol is not run.
 * Tight on purpose — "not exported" alone is excluded, because fixing a
 * genuinely-missing export that breaks an intended public type IS a real
 * correctness fix; only an admission that the code is DEAD/UNUSED qualifies.
 */
const DEADNESS_JUSTIFICATION =
  /\b(dead code|currently (?:dead|unused)|is (?:dead|unused)|unused (?:code|function|method|export|symbol|helper|logic)|never (?:called|used|invoked|imported|referenced)|not (?:called|used|invoked|referenced))\b/i;

/**
 * Deterministic backstop behind correction rule 14: drop any action whose
 * remediation is to resurrect dead code (export / wire-up an admittedly unused
 * symbol "so callers can…"). Such an action is never a correctness fix — making
 * unused code run is the Utility axis's territory (delete), and proposing it
 * contradicts the zero-dead-code policy. Fires only when BOTH a resurrection
 * verb AND an explicit deadness admission are present, so a real fix (e.g.
 * "export the type the public API requires") is preserved. Verdict handling is
 * left to rule 14 and the tier-2 DEAD coherence mute; this only removes the
 * misleading "Quick Win" artifact (cf. theraphonia getOscillatorCompensation,
 * run 2026-06-07).
 */
export function stripResurrectionActions(data: CorrectionResponse): CorrectionResponse {
  const actions = data.actions.filter(
    (a) => !(RESURRECTION_VERB.test(a.description) && DEADNESS_JUSTIFICATION.test(a.description)),
  );
  if (actions.length === data.actions.length) return data;
  return { ...data, actions };
}

/**
 * Detect which dependency is implicated in a finding detail by name match.
 * @returns The matched dependency name, or `undefined` if no dependency is mentioned or fileDeps is absent.
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


// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

/** Evaluator that detects bugs and logic errors using a two-pass LLM strategy (initial scan + verification). */
export class CorrectionEvaluator implements AxisEvaluator {
  readonly id = 'correction' as const;
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = resolveSystemPrompt('correction', ctx.task.language, ctx.task.framework);
    let userMessage = buildCorrectionUserMessage(ctx);

    // Inject known false positives from memory into the prompt
    const fileSymbols = new Set(ctx.task.symbols.map(s => s.name));
    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'correction', fileSymbols);
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
        callId: ctx.callId,
        router: ctx.router,
        userInstructions: ctx.userInstructions?.forAxis('correction'),
        composer: 'axes.correction',
        primitive: 'axes.correction-pass1',
        timeoutMs: ctx.config.runtime.timeout_per_call * 1000,
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
            callId: ctx.callId,
            router: ctx.router,
            userInstructions: ctx.userInstructions?.forAxis('correction'),
            composer: 'axes.correction',
            primitive: 'axes.correction-verify',
            timeoutMs: ctx.config.runtime.timeout_per_call * 1000,
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

    // Deterministic coherence guard: a flagged verdict whose own evidence
    // concludes "no bug" is reconciled to OK (safety net behind prompt rule 13).
    finalData = reconcileSelfContradictions(finalData);

    // Deterministic backstop behind rule 14: drop "export this dead code so
    // callers can use it" actions — resurrecting unused code is never a
    // correction fix and violates the zero-dead-code policy.
    finalData = stripResurrectionActions(finalData);

    const symbols: AxisSymbolResult[] = finalData.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.correction,
      confidence: s.confidence,
      detail: s.detail,
      findings: s.findings && s.findings.length > 0
        ? s.findings.map((f) => ({
            line_start: f.line_start,
            line_end: f.line_end,
            detail: f.detail,
          }))
        : undefined,
    }));

    const severityMapping: Record<string, { severity: 'high' | 'medium' | 'low'; effort: 'large' | 'small' | 'trivial'; category: 'refactor' | 'quickwin' | 'hygiene' }> = {
      CRITICAL: { severity: 'high', effort: 'large', category: 'refactor' },
      MAJOR: { severity: 'medium', effort: 'small', category: 'quickwin' },
      MINOR: { severity: 'low', effort: 'trivial', category: 'hygiene' },
    };

    const defaultMapping = severityMapping.MAJOR;

    const actions: Action[] = finalData.actions.map((a, i) => {
      const mapping = severityMapping[a.severity] ?? defaultMapping;
      return {
        id: i + 1,
        description: a.description,
        severity: mapping.severity,
        effort: mapping.effort,
        category: mapping.category,
        target_symbol: null,
        target_lines: a.line ? `L${a.line}` : null,
      };
    });

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
      ...(finalData.doc_divergences ? { doc_divergences: finalData.doc_divergences } : {}),
    };
  }
}
