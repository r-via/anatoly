# 18. Doc-Conflict Subsystem Cleanup (open follow-ups)

> Status: open. Scope: tech-debt left by doc 16 PR 2b/2c (store-vector
> pair matching + single-turn detection). Two independent work items,
> both non-behavioral for the audit score, both prerequisites to a clean
> PR 3b. Sibling of doc 16 (the contract) and doc 17 (the SDK plan).

## Context

Doc 16 PR 2b/2c rebuilt conflict detection around a store-vector cosine
pair matcher plus a single-turn query. The live detection path is now:

`detectNewConflictsViaLlm` ([doc-conflict-detector.ts:460](../../src/core/documentation/conflict/doc-conflict-detector.ts#L460))
to `storePairMatcher` ([doc-conflict-pairing.ts](../../src/core/documentation/conflict/doc-conflict-pairing.ts))
to `buildPairDetectionUserMessage` + `DETECTION_SYSTEM_PROMPT`
([doc-conflict-detector.ts:511](../../src/core/documentation/conflict/doc-conflict-detector.ts#L511),
[:531](../../src/core/documentation/conflict/doc-conflict-detector.ts#L531))
to `runSingleTurnQuery` (result is schema-validated, `result.data`)
to `enrichDetectedConflict` ([doc-conflict-detector.ts:307](../../src/core/documentation/conflict/doc-conflict-detector.ts#L307)).

The old monolithic whole-corpus path is no longer called. It was kept
and barrel-exported only so its own unit tests still compiled. That is
the first cleanup. The second is that the matcher already knows the
internal scaffold section a conflict came from, but that identity is
discarded before persistence.

---

## Item A. Remove the dead monolith helpers

### A.1 Dead set (no production caller; only barrel + own tests)

| Symbol | Definition | Barrel-exported | Reason dead |
|---|---|---|---|
| `segmentForDetection` | [doc-conflict-llm.ts:126](../../src/core/documentation/conflict/doc-conflict-llm.ts#L126) | no | PR 2b: segmentation moved into `storePairMatcher` |
| `buildDetectionUserMessage` | [doc-conflict-llm.ts:192](../../src/core/documentation/conflict/doc-conflict-llm.ts#L192) | yes ([index.ts:55](../../src/core/documentation/index.ts#L55)) | replaced by `buildPairDetectionUserMessage` |
| `DetectionPromptOpts` (interface) | [doc-conflict-llm.ts:161](../../src/core/documentation/conflict/doc-conflict-llm.ts#L161) | no | only consumed by `buildDetectionUserMessage` |
| `collectInternalDocFragments` | [doc-conflict-llm.ts:74](../../src/core/documentation/conflict/doc-conflict-llm.ts#L74) | no | only fed the whole-corpus message builder |
| `parseDetectionResponse` | [doc-conflict-llm.ts:376](../../src/core/documentation/conflict/doc-conflict-llm.ts#L376) | yes ([index.ts:55](../../src/core/documentation/index.ts#L55)) | PR 2c: `runSingleTurnQuery` returns schema-validated `result.data`, so manual parse is dead |
| `batchFragmentsByTokenBudget` | [doc-conflict-detector.ts:417](../../src/core/documentation/conflict/doc-conflict-detector.ts#L417) | yes ([index.ts:51](../../src/core/documentation/index.ts#L51)) | PR 2b batches pairs (`batchPairs` / `MAX_PAIRS` in `doc-conflict-pairing.ts`), not token-budgeted fragments |

### A.2 Must be kept (shared with the live path, do not delete)

- `sanitizeForInjection` ([doc-conflict-llm.ts:178](../../src/core/documentation/conflict/doc-conflict-llm.ts#L178)): also called by `buildPairDetectionUserMessage` (the live builder, lines 319 to 333). It only looks dead if you grep the old builder.
- `DETECTION_SYSTEM_PROMPT` ([doc-conflict-llm.ts:110](../../src/core/documentation/conflict/doc-conflict-llm.ts#L110)): consumed by the live `runSingleTurnQuery` call ([doc-conflict-detector.ts:531](../../src/core/documentation/conflict/doc-conflict-detector.ts#L531)).
- `DetectedConflictItem` / `DetectedConflictItemSchema` ([:34](../../src/core/documentation/conflict/doc-conflict-llm.ts#L34), [:57](../../src/core/documentation/conflict/doc-conflict-llm.ts#L57)) and `DetectionResponse` / `DetectionResponseSchema` ([:59](../../src/core/documentation/conflict/doc-conflict-llm.ts#L59)): the live schema-validated path and `enrichDetectedConflict` use them.

### A.3 Published-surface change

Dropping `batchFragmentsByTokenBudget`, `buildDetectionUserMessage`, and
`parseDetectionResponse` from the `documentation/` barrel
([index.ts:45-56](../../src/core/documentation/index.ts#L45)) shrinks the
published surface. That is the intended direction (doc 13 section 8: the
surface is exactly what external importers use, no speculative API).
Confirm no out-of-context importer references them (grep across `src/`
outside `documentation/`) before removing the export lines.

### A.4 Test policy: re-home the invariants, do not just delete coverage

The dead helpers carry real hardening invariants. Delete the tests bound
to the dead symbols, but retarget the security/robustness intent at the
live functions so coverage is not lost.

- [doc-conflict-llm.test.ts](../../src/core/documentation/conflict/doc-conflict-llm.test.ts):
  delete describes `collectInternalDocFragments` (L33),
  `buildDetectionUserMessage` (L75), `parseDetectionResponse` (L136),
  `segmentForDetection` (L229). Keep `DETECTION_SYSTEM_PROMPT` (L203)
  and `buildPairDetectionUserMessage` (L261).
- [doc-conflict-hardening.test.ts](../../src/core/documentation/conflict/doc-conflict-hardening.test.ts):
  - `hardening — prompt injection mitigation` (L113) asserts via
    `buildDetectionUserMessage`. Re-home onto `buildPairDetectionUserMessage`
    (the shared `sanitizeForInjection` is still the code under test, just
    reached through the live builder).
  - `hardening — batching` (L164) asserts via `batchFragmentsByTokenBudget`.
    The live equivalent is pair batching in
    [doc-conflict-pairing.ts](../../src/core/documentation/conflict/doc-conflict-pairing.ts)
    (`batchPairs` / `MAX_PAIRS`). Re-home the bound invariant there, or
    delete only if `batchPairs` already has equivalent tests (verify).

### A.5 Acceptance

Typecheck + lint clean, full suite green, barrel surface reduced, no
production behavior change (the deleted code already had no caller). No
bench needed (no audit-input change).

---

## Item B. Persist the internal-doc anchor (RAG summary, not anchor)

### B.1 The defect

`storePairMatcher` yields `CandidatePair { ref: DocSegment, internal:
DocSegment }`, where `DocSegment = { filePath, heading, content,
neighbor }`
([doc-conflict-pairing.ts:32-46](../../src/core/documentation/conflict/doc-conflict-pairing.ts#L32)).
So at detection time the matcher knows the exact internal scaffold
section a conflict was matched from: `internal.filePath#internal.heading`.

But the persisted record throws it away. `enrichDetectedConflict`
([doc-conflict-detector.ts:307](../../src/core/documentation/conflict/doc-conflict-detector.ts#L307))
builds a `DocConflict`
([schemas/doc-conflict.ts:69](../../src/schemas/doc-conflict.ts#L69))
with a code-only `anchor` (file / symbol / line_range / code_hash), a
`reference_excerpt`, and a prose `code_summary`. The internal section
identity is never threaded in. The conflict carries a summary where it
could carry an anchor.

### B.2 Why it matters

PR 3b (doc 16 section 6, Effect 1 de-poison) must exclude the contested
internal scaffold section from the injected `internalDocsTree` /
`internalDocsDir`. With only a prose `code_summary` it cannot map
conflict to section deterministically; it would need a gate-time
re-embed / cosine / heuristic. The data that dissolves that hard mapping
already existed at detection and was discarded.

### B.3 Fix

1. Add optional `internal_anchor: { filePath: string; heading: string }`
   to `DocConflictSchema`
   ([schemas/doc-conflict.ts:69](../../src/schemas/doc-conflict.ts#L69)),
   optional so legacy entries and the migrate-on-read path stay valid.
2. Thread `pair.internal` from `detectNewConflictsViaLlm` (where the
   pair to LLM-item correlation is known) into `enrichDetectedConflict`
   and persist it on the `DocConflict`.
3. Then PR 3b's mapping is a recorded-anchor lookup, no re-embed. The
   report / divergence section can also cite the exact internal section
   instead of a summary.

### B.4 The one non-trivial design point

`detectNewConflictsViaLlm` sends a batch of pairs and the LLM returns
conflicts keyed by code `file` / `symbol`, not by pair index. The pair
to returned-item re-association must be deterministic. Options: carry an
explicit pair id/index through the prompt and require it back in the
response schema, or re-match the returned `reference_path` /
`reference_text` against each pair's `ref` segment. Pick and specify one
before coding; this is the only real risk in Item B.

### B.5 Acceptance

Schema migration is backward-compatible (optional field, legacy entries
load), detection persists `internal_anchor` on freshly detected
conflicts, hermetic tests cover the pair to item re-association and the
persisted anchor. No live LLM in tests. Behavior-relevant only once PR 3b
consumes it; Item B alone is non-behavioral for the score and can land
independently.

---

## Ordering

Item A and Item B are independent. A is pure deletion + test re-homing
(low risk, do first). B is a prerequisite for a clean PR 3b and should
land before PR 3b is specced for implementation. Neither moves the bench;
both reduce the cost of the next doc-16 step.
