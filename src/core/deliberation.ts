// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { ReviewFile } from '../schemas/review.js';
import { contextLogger } from '../utils/log-context.js';
import { recordReclassification } from './correction-memory.js';
import { resolveSystemPrompt } from './prompt-resolver.js';
import { ALL_AXIS_IDS } from './axes/index.js';

// ---------------------------------------------------------------------------
// Deliberation response schema — what Opus returns
// ---------------------------------------------------------------------------

const AxisVerdictSchema = z.object({
  correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR', '-']).optional(),
  utility: z.enum(['USED', 'DEAD', 'LOW_VALUE', '-']).optional(),
  duplication: z.enum(['UNIQUE', 'DUPLICATE', '-']).optional(),
  overengineering: z.enum(['LEAN', 'OVER', 'ACCEPTABLE', '-']).optional(),
  tests: z.enum(['GOOD', 'WEAK', 'NONE', '-']).optional(),
  documentation: z.enum(['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED', '-']).optional(),
  confidence: z.int().min(0).max(100),
});

export const DeliberatedSymbolSchema = z.object({
  name: z.string(),
  original: AxisVerdictSchema,
  deliberated: AxisVerdictSchema,
  reasoning: z.string().min(10),
});

export const DeliberationResponseSchema = z.object({
  verdict: z.enum(['CLEAN', 'NEEDS_REFACTOR', 'CRITICAL']),
  symbols: z.array(DeliberatedSymbolSchema),
  removed_actions: z.array(z.int().min(1)).default([]),
  reasoning: z.string().min(10),
});

export type DeliberationResponse = z.infer<typeof DeliberationResponseSchema>;
export type DeliberatedSymbol = z.infer<typeof DeliberatedSymbolSchema>;

/** Axes that deliberation can reclassify — shared between apply and count logic. */
const DELIBERATION_AXES = ['correction', 'utility', 'duplication', 'overengineering', 'tests', 'documentation'] as const;
type DeliberationAxis = (typeof DELIBERATION_AXES)[number];

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the deliberation LLM pass.
 *
 * Resolves the `deliberation` prompt template and injects the current axis
 * count into every `{{AXIS_COUNT}}` placeholder.
 *
 * @returns The fully interpolated system prompt string.
 */
export function buildDeliberationSystemPrompt(): string {
  const raw = resolveSystemPrompt('deliberation');
  return raw.replace(/\{\{AXIS_COUNT\}\}/g, String(ALL_AXIS_IDS.length));
}

/**
 * Build the user-facing message for the deliberation LLM pass.
 *
 * Assembles a structured Markdown prompt containing:
 * - The merged ReviewFile serialized as JSON
 * - The full source code of the file under review
 * - Inline deliberation rules: skip clean symbols, address all axis findings
 *   per symbol together, protect ERROR (require confidence >= 95 to downgrade),
 *   require confidence >= 85 for reclassification, and prohibit adding new
 *   findings, symbols, or actions
 *
 * @param review - The merged ReviewFile from all axis evaluators.
 * @param fileContent - The raw source code of the file being reviewed.
 * @returns The fully assembled user message string for the deliberation LLM call.
 */
export function buildDeliberationUserMessage(review: ReviewFile, fileContent: string): string {
  const reviewJson = JSON.stringify(review, null, 2);
  return `## Merged ReviewFile (from ${ALL_AXIS_IDS.length} axis evaluators)

\`\`\`json
${reviewJson}
\`\`\`

## Source code of \`${review.file}\`

\`\`\`typescript
${fileContent}
\`\`\`

## Instructions

Deliberate ONLY symbols with findings — skip clean symbols. For each symbol, address ALL its axis findings together in one entry (e.g., if a symbol is DEAD + NEEDS_FIX, deliberate both in the same entry). Recompute the verdict.

Rules:
- Only include axes with findings in original/deliberated (omit clean axes)
- Do NOT add new findings, symbols, or actions
- Protect ERROR (require ≥ 95 confidence to downgrade)
- Reclassification requires confidence ≥ 85
- Copy original values when you agree with the finding`;
}

// ---------------------------------------------------------------------------
// Decision: does this file need deliberation?
// ---------------------------------------------------------------------------

/**
 * Determine whether a merged ReviewFile warrants an Opus deliberation pass.
 *
 * Returns `false` (skip) when:
 *   - verdict is CLEAN and all symbol confidences are ≥ 95
 *
 * Returns `true` (deliberate) when:
 *   - any symbol has correction NEEDS_FIX or ERROR
 *   - any symbol has utility DEAD or LOW_VALUE, duplication DUPLICATE, or overengineering OVER
 *   - verdict is CLEAN but any symbol confidence < 70
 */
export function needsDeliberation(review: ReviewFile): boolean {
  const log = contextLogger();
  const hasFindings = review.symbols.some(
    (s) =>
      s.correction === 'NEEDS_FIX' ||
      s.correction === 'ERROR' ||
      s.utility === 'DEAD' ||
      s.utility === 'LOW_VALUE' ||
      s.duplication === 'DUPLICATE' ||
      s.overengineering === 'OVER' ||
      s.tests === 'WEAK' ||
      s.tests === 'NONE' ||
      s.documentation === 'UNDOCUMENTED' ||
      s.documentation === 'PARTIAL',
  );
  if (hasFindings) {
    log.debug({ file: review.file, reason: 'has-findings' }, 'deliberation needed');
    return true;
  }

  if (review.verdict === 'CLEAN') {
    const allHighConfidence = review.symbols.every((s) => s.confidence >= 95);
    if (allHighConfidence) {
      log.debug({ file: review.file, reason: 'clean-high-confidence' }, 'deliberation skipped');
      return false;
    }

    const anyLowConfidence = review.symbols.some((s) => s.confidence < 70);
    if (anyLowConfidence) {
      log.debug({ file: review.file, reason: 'clean-low-confidence' }, 'deliberation needed');
      return true;
    }
  }

  // Non-CLEAN verdict always deliberates
  if (review.verdict !== 'CLEAN') {
    log.debug({ file: review.file, reason: 'non-clean-verdict', verdict: review.verdict }, 'deliberation needed');
    return true;
  }

  // CLEAN with medium confidence (70-94): skip deliberation
  log.debug({ file: review.file, reason: 'clean-medium-confidence' }, 'deliberation skipped');
  return false;
}

// ---------------------------------------------------------------------------
// Apply deliberation results to a ReviewFile
// ---------------------------------------------------------------------------

/**
 * Apply Opus deliberation results to the original merged ReviewFile.
 *
 * - Reclassifies symbol corrections (respecting ERROR protection)
 * - Adjusts confidences
 * - Removes invalidated actions
 * - Applies Opus verdict
 * - Enriches symbol detail with deliberation reasoning
 *
 * @param review - The original merged ReviewFile to update.
 * @param deliberation - The parsed deliberation response from Opus.
 * @param projectRoot - When provided, reclassifications are recorded to the
 *   correction-memory file via {@link recordReclassification} so that future
 *   runs can learn from false-positive patterns.
 * @returns A new ReviewFile with deliberation results applied and verdict
 *   recomputed for coherence.
 */
export function applyDeliberation(
  review: ReviewFile,
  deliberation: DeliberationResponse,
  projectRoot?: string,
): ReviewFile {
  const deliberatedMap = new Map(
    deliberation.symbols.map((s) => [s.name, s]),
  );

  const removedActionIds = new Set(deliberation.removed_actions);

  const symbols = review.symbols.map((sym) => {
    const delib = deliberatedMap.get(sym.name);
    if (!delib) return sym;

    const newConfidence = delib.deliberated.confidence;
    const changes: string[] = [];
    const updated = { ...sym, confidence: newConfidence };

    // Apply each axis reclassification using typed setter
    for (const axis of DELIBERATION_AXES) {
      const orig = delib.original[axis];
      const deliberated = delib.deliberated[axis];
      if (!orig || !deliberated) continue;

      // Protect ERROR corrections: only allow downgrade if confidence ≥ 95
      if (axis === 'correction' && orig === 'ERROR' && deliberated !== 'ERROR' && newConfidence < 95) {
        changes.push(`${axis}: ERROR protected (confidence ${newConfidence} < 95)`);
        continue;
      }

      if (orig !== deliberated) {
        changes.push(`${axis}: ${orig} → ${deliberated}`);

        // Record any reclassification as a false positive for future runs
        if (projectRoot) {
          recordReclassification(projectRoot, {
            pattern: `[deliberation] ${sym.name}: ${axis} ${orig} → ${deliberated}`,
            axis,
            original_detail: sym.detail,
            reason: `Deliberation reclassified: ${delib.reasoning}`,
          });
        }
      }
      setAxisValue(updated, axis, deliberated);
    }

    const changesSummary = changes.length > 0
      ? `reclassified: ${changes.join(', ')}`
      : 'confirmed';
    updated.detail = `${sym.detail} (deliberated: ${changesSummary} — ${delib.reasoning})`;

    return updated;
  });

  const actions = review.actions.filter((a) => !removedActionIds.has(a.id));

  // Recompute verdict from final symbols to ensure coherence
  // (Opus may say CLEAN but ERROR protection could have kept ERROR symbols)
  const verdict = recomputeVerdict(symbols, deliberation.verdict);

  const reclassified = deliberation.symbols.filter((s) =>
    DELIBERATION_AXES.some((axis) => {
      const orig = s.original[axis];
      const delib = s.deliberated[axis];
      return orig && delib && orig !== delib;
    }),
  ).length;

  contextLogger().debug(
    {
      file: review.file,
      symbolsDeliberated: deliberation.symbols.length,
      reclassified,
      actionsRemoved: deliberation.removed_actions.length,
      verdictBefore: review.verdict,
      verdictAfter: verdict,
    },
    'deliberation applied',
  );

  return {
    ...review,
    verdict,
    symbols,
    actions,
    deliberation: {
      verdict_before: review.verdict,
      verdict_after: verdict,
      reclassified,
      actions_removed: deliberation.removed_actions.length,
      reasoning: deliberation.reasoning,
    },
  };
}

/** Type-safe setter for axis values on a SymbolReview, avoiding `as Record<string, unknown>`. */
function setAxisValue(
  sym: ReviewFile['symbols'][number],
  axis: DeliberationAxis,
  value: string,
): void {
  switch (axis) {
    case 'correction': sym.correction = value as typeof sym.correction; break;
    case 'utility': sym.utility = value as typeof sym.utility; break;
    case 'duplication': sym.duplication = value as typeof sym.duplication; break;
    case 'overengineering': sym.overengineering = value as typeof sym.overengineering; break;
    case 'tests': sym.tests = value as typeof sym.tests; break;
    case 'documentation': sym.documentation = value as typeof sym.documentation; break;
  }
}

/**
 * Recompute the verdict from actual symbol state, using Opus's verdict as a
 * starting point but escalating if the symbols contradict it.
 */
function recomputeVerdict(
  symbols: ReviewFile['symbols'],
  opusVerdict: 'CLEAN' | 'NEEDS_REFACTOR' | 'CRITICAL',
): 'CLEAN' | 'NEEDS_REFACTOR' | 'CRITICAL' {
  let hasError = false;
  let hasFinding = false;

  for (const s of symbols) {
    if (s.correction === 'ERROR') hasError = true;
    if (s.correction === 'NEEDS_FIX') hasFinding = true;
    if (
      s.utility === 'DEAD' || s.utility === 'LOW_VALUE' ||
      s.duplication === 'DUPLICATE' ||
      s.overengineering === 'OVER' ||
      s.tests === 'WEAK' || s.tests === 'NONE' ||
      s.documentation === 'UNDOCUMENTED'
    ) {
      hasFinding = true;
    }
  }

  // Never allow a verdict less severe than what the symbols demand
  if (hasError) return 'CRITICAL';
  if (hasFinding && opusVerdict === 'CLEAN') return 'NEEDS_REFACTOR';
  return opusVerdict;
}
