# 3-Tier Refinement Pipeline

The refinement pipeline is a post-review validation phase that eliminates false positives, resolves inter-axis contradictions, and investigates ambiguous findings. It replaces the legacy per-file Opus deliberation with a three-tier approach: deterministic auto-resolve, coherence rules, and agentic investigation.

## The Deliberation Engagement

Anatoly's engagement is that **every finding-producing axis is eligible for deliberation**: no axis is structurally barred from the refinement pipeline. This is the eligibility guarantee, not a per-finding cost promise. Concretely:

1. Every axis flows through tiers 1 and 2. A finding is never reported without passing the deterministic false-positive and inter-axis coherence checks.
2. Every axis is escalatable to tier 3 (Opus). The tier-2 escalation criteria (isolation, confidence band, behavioral signal, systemic pattern) decide which findings actually consume an Opus call. A high-confidence finding that survives tiers 1 and 2 is considered confirmed by deterministic proof and does not need an Opus call to honor the engagement.
3. No axis is excluded from the deliberable set by construction. The guarantee is "eligible for arbitration plus proven", which matches the README ("arbitration on disputed findings" plus "every finding is proven with a file, a line, and the evidence trail").

This is engagement reading A, chosen over "every finding gets an Opus call" (too costly, breaks the $0/token subscription value) and over "deterministic axes need no deliberation at all" (leaves flow and best_practices as second-class axes).

### Per-axis eligibility

Two deliberation mechanisms exist because findings have two shapes:

| Axis | Finding shape | Deliberation path |
|------|---------------|-------------------|
| correction, utility, duplication, overengineering, tests, documentation | per-symbol verdict (`SymbolReview.<axis>`) | verdict path: tier-2 escalation + tier-3 reclassify over `DELIBERATION_AXES` |
| flow | per-symbol verdict (`SymbolReview.flow`) | verdict path (same as above): flow joins `DELIBERATION_AXES` |
| best_practices | file-level (`ReviewFile.best_practices`), no per-symbol verdict | file-level path (a distinct escalate-and-reclassify channel for file-level findings) |
| invariants (pipeline phase, not an axis) | `SymbolReview.invariant_findings` | satisfied in-phase by its own adversarial judge (same-quantity-and-disagreement, default-to-no-finding); documented as an equivalent deliberation mechanism, not the tier-3 path |

The flow axis already carries a per-symbol verdict identical in shape to correction, so it reaches the engagement through the existing verdict path simply by joining `DELIBERATION_AXES` and the tier-2 escalation rules. The best_practices axis is file-level and reaches the engagement through the file-level channel: tier 2 escalates each FAILED rule keyed by its rule name (with a self-contained detail, since there is no per-symbol entry to look up), tier 3 verifies it via the shared machinery, and `applyDeliberation` writes the reclassified status back onto `review.best_practices.rules`. With both channels in place, every axis is eligible and there is no remaining structural exclusion.

### Determinism and caching

The flow axis is LLM-free: it derives its verdict from the `flows.json` artifact. Its per-axis review cache key must therefore include the artifact's content hash (or the axis must not be cached), otherwise a verdict computed before the artifact existed is served stale after it appears. Eligibility for deliberation does not change this: the producer is re-evaluated deterministically, then its findings flow through the pipeline like any other axis.

### Implementation status

This section is the design contract. Status of the increments:

1. **Done (increment 1).** flow is on the verdict path: it joins `DELIBERATION_AXES`, has a field on the deliberation `AxisVerdictSchema` and `setAxisValue`, a tier-3 prompt section on verifying structural flow claims, and a tier-2 escalation rule scoped to FP-prone natures (`unwired_flow`) and low resolution confidence, so high-confidence structural facts (e.g. `over_indirect`) stay deterministically confirmed. The flow axis now propagates its per-flow resolution confidence (instead of a flat constant) so the low-confidence escalation criterion is meaningful.
2. **Done.** The flow per-axis review cache key now folds in the `flows.json` content hash (review.ts), so a verdict computed against a different or absent artifact is invalidated. A second, deeper defect is also fixed: `mergeRefreshedReview` (review-merge.ts) historically omitted the `flow` field, so a partial cache-served run that re-evaluated flow had its fresh verdict dropped and the cached `'-'` kept, silently zeroing flow findings (observed on theraphonia: `--axes flow` reported 0 findings under cache, 47 under `--no-cache`). The merge now carries flow.
3. **Done (increment 2).** best_practices now reaches deliberation through the file-level channel: tier 2 escalates each FAILED rule (keyed by rule name, carrying a self-contained detail; WARN is advisory and left as-is to bound cost), the shared tier-3 machinery verifies it, and `applyDeliberation` reclassifies the rule status on `review.best_practices.rules` via a dedicated sink (best_practices is deliberately NOT in `DELIBERATION_AXES`, which is the per-symbol set). The `EscalatedFinding.detail` field carries the rule text so tier 3 has context without a per-symbol lookup. With this, no axis is structurally excluded from the engagement.

Known limitation: the flow axis verdicts (`OK`/`NEEDS_FIX`) reuse the same tags as correction in the pipe-delimited `detail` format, which assumes globally distinct verdict tags. The flow verdict field is merged and reclassified correctly, but in a full run where a symbol carries both a correction and a flow finding, the per-axis `detail` segment lookup (render-axis `axisDetail`, the reclassification-memory `axisForTag` map) can attribute the wrong rationale text between the two. This is a display/memory cosmetic, not a verdict-correctness issue; namespacing the flow detail tags is a follow-up.

## When It Runs

Refinement is controlled by two settings:

1. **CLI flag:** `--deliberation` / `--no-deliberation` (takes precedence)
2. **Config:** `llm.deliberation` (boolean, default from config)

When enabled, the refinement phase runs after all files have been reviewed and their ReviewFile JSON/MD written to disk. The three tiers execute sequentially.

## Pipeline Overview

```
Review phase (7 axes per file, parallel)
  → write ReviewFile JSON + MD (no deliberation)
  ↓
Tier 1: Deterministic auto-resolve (0 tokens, < 1s)
  ↓
Tier 2: Inter-axis coherence rules (0 tokens, < 1s)
  ↓
Tier 3: Agentic investigation (Opus + tools, post-run)
  ↓
Write refined ReviewFiles → Report phase
```

## Tier 1 — Deterministic Auto-Resolve

Resolves trivially false findings using structured data already available (usage graph, AST, RAG index). No LLM calls.

| Finding | Resolution | Data source |
|---------|-----------|-------------|
| DEAD (exported + runtime importers > 0) | → USED | Usage graph |
| DEAD (exported + type-only importers > 0) | → USED | Usage graph |
| DEAD (exported + transitive usage) | → USED | Usage graph |
| DUPLICATE (no RAG candidates or score < 0.68) | → UNIQUE | RAG index |
| DUPLICATE (function ≤ 2 lines) | → UNIQUE | AST |
| OVER (kind = interface/type/enum) | → LEAN | AST |
| OVER (function ≤ 5 lines) | → LEAN | AST |
| UNDOCUMENTED (JSDoc block exists, > 20 chars) | → DOCUMENTED | AST |
| UNDOCUMENTED (self-descriptive type ≤ 5 fields) | → DOCUMENTED | AST |
| Any finding on `__gold-set__` or `__fixtures__` file | → skip | Path pattern |

**Implementation:** `src/core/refinement/tier1.ts` — pure function, no side effects.

## Tier 2 — Inter-Axis Coherence Rules

Detects logical contradictions between axes and resolves them deterministically. No LLM calls.

| Pattern | Resolution | Reasoning |
|---------|-----------|-----------|
| DEAD + NEEDS_FIX | correction → OK | No point fixing dead code |
| DEAD + OVER | overengineering → skip | No point evaluating dead code complexity |
| DEAD + DUPLICATE | duplication → skip | No point deduplicating dead code |
| DEAD + WEAK/NONE | tests → skip | No tests needed for dead code |
| DEAD + UNDOCUMENTED | documentation → skip | No docs needed for dead code |
| LOW_VALUE + OVER | overengineering → skip | No point refactoring low-value code |
| LOW_VALUE + UNDOCUMENTED | documentation → skip | No point documenting low-value code |

Tier 2 also **escalates** findings to tier 3 when they require investigation:

- correction ERROR → always escalated
- NEEDS_FIX with confidence < 75 and no other findings → escalated
- Findings mentioning defaults, config, thresholds → escalated (behavioral change)
- Systemic patterns (> 10 DEAD symbols in a module) → escalated

**Implementation:** `src/core/refinement/tier2.ts` — pure function with cross-file pattern detection.

## Tier 3 — Agentic Investigation

A full Opus agent with tool access investigates the findings escalated by tier 2. Unlike tiers 1-2, this tier calls the LLM and reads actual source code.

**Tools available:** Read, Grep, Glob, Bash, WebFetch

**Transport:** Tier 3 uses `TransportRouter.agenticQuery()` which routes to the appropriate backend based on provider mode. In subscription mode, the Claude Code subprocess runs with full tool access. In API mode, the Vercel AI SDK agent runs with bash (and future custom tools). See [Transport Architecture](./08-Transport-Architecture.md) for the full dispatch matrix.

**Retry/backoff:** Built into `agenticQuery()` — 3 retries with exponential backoff (5s base, 60s max). Failures trip the per-provider circuit breaker to prevent cascade.

**Process:**
1. Escalated findings are grouped into shards by module/directory
2. For each shard, the agent receives only the list of claims to verify (not the source code)
3. The agent reads files, greps for usages, checks configs, and verifies each claim
4. It produces a JSON response with confirmed/reclassified verdicts and evidence

**Key principle:** The agent receives claims, not evidence. It must investigate and prove or disprove each finding itself.

**System prompt:** `src/prompts/refinement/tier3-investigation.system.md`

**Verification principles (from the prompt):**
- Intent vs. defect: is the code wrong, or intentionally written this way?
- Bug vs. preference: only actual defects are NEEDS_FIX
- Observable evidence: assumptions lower confidence
- Blast radius: behavioral changes require stronger evidence
- Dynamic vs. static: runtime values may differ from documentation
- Trace the full chain: when a finding disputes a value, trace its origin end-to-end

### Refinement Cache

Tier 3 results are persisted per-finding in `refinement-cache.json` (in the run directory). This enables:

- **Crash recovery:** if a shard fails mid-investigation, the next run resumes at the next unprocessed finding
- **Incremental runs:** findings already investigated are skipped
- **Cache key:** `file::symbol::axis` — unique per finding

### Deliberation Memory

Tier 3 is the only tier that writes to `deliberation-memory.json`. This persistent registry prevents the same false positive from being re-investigated across runs. The memory is also used to inject "Known False Positives" into axis prompts.

## Output Format

Tier 3 uses the same `DeliberationResponse` schema as the legacy deliberation:

```json
{
  "verdict": "CLEAN | NEEDS_REFACTOR | CRITICAL",
  "symbols": [
    {
      "name": "symbolName",
      "original": { "correction": "NEEDS_FIX", "confidence": 72 },
      "deliberated": { "correction": "OK", "confidence": 90 },
      "reasoning": "Checked src/scanner.ts:45 — the value is set dynamically by the smoke test..."
    }
  ],
  "removed_actions": [1, 3],
  "reasoning": "Overall investigation summary"
}
```

## Performance

Benchmarked on rustguard (41 Rust files):

| Metric | Legacy (per-file Opus) | 3-Tier | Delta |
|--------|----------------------|--------|-------|
| Total time | 58 min | 45 min | -22% |
| Per-file avg | 331s | 220s | -34% |
| Cost | $47.58 | $38.23 | -20% |
| CLEAN files | 4 | 10 | +150% |
| Findings | 76 | 72 | -4 |

Tier 1+2 are free (0 tokens). Tier 3 adds 7-8 min post-run for 2 shards.

## Failure Handling

- **Tier 1/2 failure:** impossible (deterministic code, no I/O)
- **Tier 3 shard failure:** isolated per shard — failed shards don't block others
- **Tier 3 crash:** refinement cache preserves progress — next run resumes
- **All tiers skipped:** when `--no-deliberation` is set, ReviewFiles are used as-is
