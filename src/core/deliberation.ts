import { z } from 'zod';
import type { ReviewFile } from '../schemas/review.js';

// ---------------------------------------------------------------------------
// Deliberation response schema — what Opus returns
// ---------------------------------------------------------------------------

export const DeliberatedSymbolSchema = z.object({
  name: z.string(),
  original: z.object({
    correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
    confidence: z.int().min(0).max(100),
  }),
  deliberated: z.object({
    correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
    confidence: z.int().min(0).max(100),
  }),
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

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildDeliberationSystemPrompt(): string {
  return `You are Anatoly's Deliberation Judge — a senior TypeScript auditor performing a FINAL validation pass on merged review results.

## Your role

You receive a ReviewFile (merged from 6 independent axis evaluators) and the original source code. Your job is to:

1. **Verify inter-axis coherence** — do the combined findings make sense together?
2. **Filter residual false positives** — reclassify NEEDS_FIX → OK when the finding is incorrect.
3. **Protect confirmed ERRORs** — do NOT downgrade ERROR findings unless you are extremely confident (≥ 95) the original assessment was wrong.
4. **Adjust confidences** — raise or lower confidence based on cross-axis evidence.
5. **Remove invalid actions** — list action IDs that should be removed due to reclassification.
6. **Recompute verdict** — based on your adjusted symbols.

## Strict rules

- You MUST NOT add new findings or new symbols. You can only modify existing ones.
- You MUST NOT add new actions. You can only remove existing ones.
- For each symbol, you MUST provide reasoning (min 10 chars) explaining your decision.
- When reclassifying, your deliberated confidence MUST be ≥ 85.
- When keeping the original assessment unchanged, copy original values to deliberated.
- ERROR → OK reclassification is only allowed if your confidence is ≥ 95.
- Provide global reasoning explaining your overall assessment.

## Output format

Output ONLY a raw JSON object (no markdown fences, no explanation):

{
  "verdict": "CLEAN | NEEDS_REFACTOR | CRITICAL",
  "symbols": [
    {
      "name": "symbolName",
      "original": { "correction": "NEEDS_FIX", "confidence": 72 },
      "deliberated": { "correction": "OK", "confidence": 90 },
      "reasoning": "The pattern is safe in the installed version of the library..."
    }
  ],
  "removed_actions": [1, 3],
  "reasoning": "Overall assessment: ..."
}`.trimEnd();
}

export function buildDeliberationUserMessage(review: ReviewFile, fileContent: string): string {
  const reviewJson = JSON.stringify(review, null, 2);
  return `## Merged ReviewFile (from 6 axis evaluators)

\`\`\`json
${reviewJson}
\`\`\`

## Source code of \`${review.file}\`

\`\`\`typescript
${fileContent}
\`\`\`

## Instructions

Review the merged findings above. For EACH symbol in the review, output your deliberation with original and deliberated correction+confidence. Remove action IDs that are no longer valid after reclassification. Recompute the verdict based on your final assessments.

Remember:
- Do NOT add new findings or symbols
- Do NOT add new actions
- Protect ERROR findings (require ≥ 95 confidence to downgrade)
- Your deliberated confidence must be ≥ 85 for any reclassification
- Copy original values to deliberated when you agree with the assessment`;
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
 *   - any symbol has utility DEAD, duplication DUPLICATE, or overengineering OVER
 *   - verdict is CLEAN but any symbol confidence < 70
 */
export function needsDeliberation(review: ReviewFile): boolean {
  const hasFindings = review.symbols.some(
    (s) =>
      s.correction === 'NEEDS_FIX' ||
      s.correction === 'ERROR' ||
      s.utility === 'DEAD' ||
      s.duplication === 'DUPLICATE' ||
      s.overengineering === 'OVER',
  );
  if (hasFindings) return true;

  if (review.verdict === 'CLEAN') {
    const allHighConfidence = review.symbols.every((s) => s.confidence >= 95);
    if (allHighConfidence) return false;

    const anyLowConfidence = review.symbols.some((s) => s.confidence < 70);
    if (anyLowConfidence) return true;
  }

  // Non-CLEAN verdict always deliberates
  if (review.verdict !== 'CLEAN') return true;

  // CLEAN with medium confidence (70-94): skip deliberation
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
 */
export function applyDeliberation(
  review: ReviewFile,
  deliberation: DeliberationResponse,
): ReviewFile {
  const deliberatedMap = new Map(
    deliberation.symbols.map((s) => [s.name, s]),
  );

  const removedActionIds = new Set(deliberation.removed_actions);

  const symbols = review.symbols.map((sym) => {
    const delib = deliberatedMap.get(sym.name);
    if (!delib) return sym;

    const originalCorrection = delib.original.correction;
    const newCorrection = delib.deliberated.correction;
    const newConfidence = delib.deliberated.confidence;

    // Protect ERROR: only allow downgrade if Opus confidence ≥ 95
    if (originalCorrection === 'ERROR' && newCorrection !== 'ERROR' && newConfidence < 95) {
      return {
        ...sym,
        detail: `${sym.detail} (deliberated: ERROR protected — Opus confidence ${newConfidence} < 95)`,
      };
    }

    // Apply reclassification
    const correctionChanged = originalCorrection !== newCorrection;
    const enrichedDetail = correctionChanged
      ? `${sym.detail} (deliberated: ${originalCorrection} → ${newCorrection} — ${delib.reasoning})`
      : `${sym.detail} (deliberated: confirmed — ${delib.reasoning})`;

    return {
      ...sym,
      correction: newCorrection,
      confidence: newConfidence,
      detail: enrichedDetail,
    };
  });

  const actions = review.actions.filter((a) => !removedActionIds.has(a.id));

  return {
    ...review,
    verdict: deliberation.verdict,
    symbols,
    actions,
  };
}
