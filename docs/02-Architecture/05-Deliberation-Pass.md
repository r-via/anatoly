# Deliberation Pass

The deliberation pass is an optional validation phase where a stronger model (typically Claude Opus) reviews the merged output of all six axis evaluators. Its purpose is to catch inter-axis contradictions, filter residual false positives, and ensure the final verdict is coherent.

## When It Runs

Deliberation is controlled by two settings:

1. **CLI flag:** `--deliberation` / `--no-deliberation` (takes precedence)
2. **Config:** `llm.deliberation` (boolean, default from config)

The model used for deliberation is configured separately via `llm.deliberation_model`.

Even when enabled globally, deliberation is **skipped** for files that do not need it. The `needsDeliberation` function applies a selective filter:

### Files That Trigger Deliberation

- Any symbol has correction = `NEEDS_FIX` or `ERROR`
- Any symbol has utility = `DEAD`
- Any symbol has duplication = `DUPLICATE`
- Any symbol has overengineering = `OVER`
- Verdict is not `CLEAN` (i.e., `NEEDS_REFACTOR` or `CRITICAL`)
- Verdict is `CLEAN` but any symbol has confidence below 70

### Files That Skip Deliberation

- Verdict is `CLEAN` and all symbol confidences are >= 95 (high-confidence clean)
- Verdict is `CLEAN` and all symbol confidences are in the 70-94 range (medium-confidence clean)

This selective approach means that clean files with solid confidence scores avoid the additional cost of an Opus call entirely.

## What It Does

The deliberation judge receives two inputs:

1. The complete merged `ReviewFile` (JSON with all symbol verdicts, actions, and axis metadata)
2. The original source code of the file

It performs five tasks:

### 1. Inter-Axis Coherence Verification

Checks whether the combined findings from all seven axes make sense together. For example, if the utility axis says a function is `DEAD` but the correction axis flagged a bug in it, the deliberation judge determines which assessment better reflects reality.

### 2. False Positive Filtering

Reclassifies `NEEDS_FIX` findings to `OK` when the original assessment was incorrect. This is the primary value of deliberation -- the stronger model can catch mistakes that the individual axis evaluators made.

### 3. ERROR Protection

ERROR findings receive special protection. The deliberation judge can only downgrade an ERROR to a less severe classification if its confidence is >= 95. This prevents the deliberation pass from accidentally dismissing genuine critical bugs.

### 4. Confidence Adjustment

Raises or lowers confidence values based on cross-axis evidence. A correction finding that is corroborated by the best_practices axis may see its confidence increased. A finding that contradicts other axes may be lowered.

### 5. Action Cleanup

When a symbol is reclassified (e.g., NEEDS_FIX to OK), the associated actions become invalid. The deliberation judge outputs a list of action IDs to remove.

## Output Format

The deliberation response follows a strict schema:

```json
{
  "verdict": "CLEAN | NEEDS_REFACTOR | CRITICAL",
  "symbols": [
    {
      "name": "symbolName",
      "original": { "correction": "NEEDS_FIX", "confidence": 72 },
      "deliberated": { "correction": "OK", "confidence": 90 },
      "reasoning": "The pattern is safe because..."
    }
  ],
  "removed_actions": [1, 3],
  "reasoning": "Overall assessment explaining the deliberation decisions"
}
```

Each symbol entry includes both the original and deliberated values, making the changes transparent and auditable.

## Applying Deliberation Results

The `applyDeliberation` function merges the Opus response back into the original `ReviewFile`:

1. For each deliberated symbol, apply the new correction and confidence values
2. Enforce ERROR protection: if the original was ERROR and Opus's confidence for downgrading is below 95, keep ERROR
3. Enrich the symbol detail string with the deliberation reasoning (e.g., `"(deliberated: NEEDS_FIX -> OK -- The pattern is safe...)"`)
4. Remove invalidated actions by their IDs
5. Recompute the verdict from the final symbol state, not just from what Opus said -- if ERROR protection kept an ERROR symbol, the verdict escalates to CRITICAL regardless of Opus's recommendation

> **Note:** `recomputeVerdict` (used after deliberation) does NOT apply the confidence >= 60 threshold that `computeVerdict` uses during the initial axis merge. All symbols are considered regardless of confidence. This is a meaningful behavioral difference -- after deliberation, even low-confidence symbols can influence the file verdict.

## Cost Implications

Deliberation adds one additional LLM call per qualifying file, using the deliberation model (typically Claude Opus, which is more expensive than Sonnet or Haiku).

**Cost factors:**

- **Input tokens:** the full merged ReviewFile (JSON) plus the complete source code of the file
- **Output tokens:** the deliberation response (smaller than the review itself)
- **Frequency:** only files with findings or low-confidence results trigger deliberation. In practice, on a well-maintained codebase, this is often 10-30% of files.

**Cost optimization strategies:**

1. **Disable for CI:** use `--no-deliberation` in CI pipelines where speed matters more than precision
2. **Enable for release audits:** use `--deliberation` before releases when you want maximum accuracy
3. **Selective model:** configure `llm.deliberation_model` to use a mid-tier model if Opus is too expensive

## Failure Handling

If the deliberation pass fails (API error, timeout, validation failure), the original merged review is kept unchanged. The failure is logged in the transcript but does not block the report phase. This means deliberation is purely additive -- it can only improve results, never break them.
