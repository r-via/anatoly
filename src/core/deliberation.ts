// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { ReviewFile } from '../schemas/review.js';
import { contextLogger } from '../utils/log-context.js';
import { recordReclassification, type AxisReclassification } from './correction-memory.js';
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
 * @deprecated Per-file deliberation removed in Story 41.1. Retained for
 *   potential reuse by tier 3 agentic investigation (Story 41.4).
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
 * @deprecated Per-file deliberation removed in Story 41.1. Retained for
 *   potential reuse by tier 3 agentic investigation (Story 41.4).
 * @param review - The merged ReviewFile from all axis evaluators.
 * @param fileContent - The raw source code of the file being reviewed.
 * @returns The fully assembled user message string for the deliberation LLM call.
 */
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.cs': 'csharp',
  '.sh': 'bash', '.bash': 'bash',
};

export function buildDeliberationUserMessage(
  review: ReviewFile,
  fileContent: string,
  testFile?: { name: string; content: string },
): string {
  const reviewJson = JSON.stringify(review, null, 2);
  const ext = review.file.slice(review.file.lastIndexOf('.'));
  const codeLang = EXT_TO_LANG[ext] ?? 'typescript';
  const parts: string[] = [];

  parts.push(`## Merged ReviewFile (from ${ALL_AXIS_IDS.length} axis evaluators)

\`\`\`json
${reviewJson}
\`\`\``);

  parts.push(`## Source code of \`${review.file}\`

\`\`\`${codeLang}
${fileContent}
\`\`\``);

  // Inject test file content so deliberation can independently verify tests axis findings
  if (testFile) {
    const MAX_TEST_LINES = 500;
    const lines = testFile.content.split('\n');
    const truncated = lines.length > MAX_TEST_LINES;
    const testExt = testFile.name.slice(testFile.name.lastIndexOf('.'));
    const testLang = EXT_TO_LANG[testExt] ?? codeLang;
    parts.push(`## Test File: \`${testFile.name}\`

\`\`\`${testLang}
${truncated ? lines.slice(0, MAX_TEST_LINES).join('\n') : testFile.content}
\`\`\`${truncated ? `\n*(truncated — ${lines.length} lines total, showing first ${MAX_TEST_LINES})*` : ''}`);
  }

  parts.push(`## Instructions

Deliberate ONLY symbols with findings — skip clean symbols. For each symbol, address ALL its axis findings together in one entry (e.g., if a symbol is DEAD + NEEDS_FIX, deliberate both in the same entry). Recompute the verdict.

Rules:
- Only include axes with findings in original/deliberated (omit clean axes)
- Do NOT add new findings, symbols, or actions
- Protect ERROR (require ≥ 95 confidence to downgrade)
- Reclassification requires confidence ≥ 85
- Copy original values when you agree with the finding
- When a test file is provided, use it to independently verify tests axis findings — reclassify WEAK→GOOD or NONE→WEAK/GOOD if the test file covers the symbol adequately`);

  return parts.join('\n\n');
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
 *
 * @deprecated Per-file deliberation removed in Story 41.1. Retained for
 *   potential reuse by tier 3 agentic investigation (Story 41.4).
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
    const axisReclassifications: AxisReclassification[] = [];
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
        axisReclassifications.push({ axis, from: String(orig), to: String(deliberated) });
      }
      setAxisValue(updated, axis, deliberated);
    }

    // Record all axis reclassifications as a single symbol entry.
    // Truncate original_detail to only the axes that were reclassified —
    // the full multi-axis detail string is too verbose for memory storage.
    if (projectRoot && axisReclassifications.length > 0) {
      const reclassifiedAxes = new Set(axisReclassifications.map((r) => r.axis));
      const detailSegments = sym.detail.split(' | ');
      const relevantDetail = detailSegments
        .filter((seg) => {
          const tag = seg.match(/^\[([A-Z_]+)\]/)?.[1];
          if (!tag) return false;
          // Match axis tags: USED/DEAD→utility, UNIQUE/DUPLICATE→duplication, etc.
          const axisForTag: Record<string, string> = {
            USED: 'utility', DEAD: 'utility', LOW_VALUE: 'utility',
            UNIQUE: 'duplication', DUPLICATE: 'duplication',
            OK: 'correction', NEEDS_FIX: 'correction', ERROR: 'correction',
            LEAN: 'overengineering', OVER: 'overengineering', ACCEPTABLE: 'overengineering',
            GOOD: 'tests', WEAK: 'tests', NONE: 'tests',
            DOCUMENTED: 'documentation', PARTIAL: 'documentation', UNDOCUMENTED: 'documentation',
          };
          return reclassifiedAxes.has(axisForTag[tag] ?? '');
        })
        .join(' | ');
      recordReclassification(projectRoot, {
        symbol: sym.name,
        reclassifications: axisReclassifications,
        original_detail: relevantDetail || sym.detail.slice(0, 200),
        reason: `Deliberation reclassified: ${delib.reasoning}`,
      });
    }

    const changesSummary = changes.length > 0
      ? `reclassified: ${changes.join(', ')}`
      : 'confirmed';
    updated.detail = `${sym.detail} (deliberated: ${changesSummary} — ${delib.reasoning})`;

    return updated;
  });

  // Auto-prune low-value actions that deliberation didn't explicitly remove:
  // - Doc actions on non-exported small symbols (private helpers don't need doc actions)
  // - Test actions on non-exported small symbols
  const symMap = new Map(review.symbols.map((s) => [s.name, s]));
  const autoPruned = new Set<number>();
  for (const action of review.actions) {
    if (removedActionIds.has(action.id)) continue;
    if (!action.target_symbol) continue;
    // Handle grouped actions with comma-separated target_symbol (e.g. "foo, bar, baz")
    const targetNames = action.target_symbol.split(/,\s*/);
    const allPrivateSmall = targetNames.every(name => {
      const sym = symMap.get(name);
      if (!sym) return false;
      const symbolSize = sym.line_end - sym.line_start + 1;
      return !sym.exported && symbolSize < 15;
    });
    if (allPrivateSmall && targetNames.length > 0 && (action.source === 'documentation' || action.source === 'tests')) {
      autoPruned.add(action.id);
    }
  }

  const allRemovedIds = new Set([...removedActionIds, ...autoPruned]);
  const actions = review.actions.filter((a) => !allRemovedIds.has(a.id));

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
      s.documentation === 'UNDOCUMENTED' || s.documentation === 'PARTIAL'
    ) {
      hasFinding = true;
    }
  }

  // Never allow a verdict less severe than what the symbols demand
  if (hasError) return 'CRITICAL';
  if (hasFinding && opusVerdict === 'CLEAN') return 'NEEDS_REFACTOR';
  return opusVerdict;
}
