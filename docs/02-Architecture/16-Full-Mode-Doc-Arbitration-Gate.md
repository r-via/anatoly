# Full-Mode Doc Arbitration Gate (execution contract)

> Status: this document is the **execution contract** for the full-mode rule
> the owner stated and the codebase does not implement: in `full` mode the
> code-scaffolded internal doc must be ratified against the human-authored
> external reference before it can feed the audit, the owner chooses what is
> preserved (external-fact vs internal-fact), and the internal-docs scaffold
> must **not** be injected into the axes while conflicts are unresolved, the
> rule whose purpose is to prevent the context-rot loop where a scaffold
> derived from buggy code teaches the auditor that the bug is the spec. It is
> the structural sibling of
> [11](./11-Orchestration-Remediation-Plan.md) /
> [13](./13-Core-Module-Remediation-Plan.md) /
> [14](./14-Orchestration-Sink-Convention.md) /
> [15](./15-Observability-Enforcement-Contract.md) and follows their proven
> shape (grounded diagnosis, ascending-risk PR sequence, testable invariants,
> bench-gated).
>
> Constraint set by the owner, verbatim in intent: *normally in full mode the
> doc scaffolded from the code must be ratified for its conflicts with the
> external doc; the user chooses what must be preserved, external or internal
> fact; I should have conflicts to arbitrate, or the internal doc should not
> be injected until resolved, that is the rule to avoid the context-rot loop.*
> Every step here is behavior-relevant by intent (it changes what reaches the
> auditor) and therefore bench-gated, or it does not ship.
>
> **Scope.** This is the behavior-correctness layer that
> [15](./15-Observability-Enforcement-Contract.md) made visible: doc 15
> closed the doc-conflict **cost** leak and proved doc-conflict-detection is a
> real, LLM-calling unit; this contract addresses what that unit's output is
> (or is not) allowed to do to the audit. It supersedes the
> "correction-axis = prompt quality" framing: the dominant correction lever is
> not the axis prompt, it is that an internal doc derived from buggy code is
> injected into the auditor with no ratification barrier.

## 1. The decision

Two stances on the relationship between unresolved doc conflicts and the
internal-docs scaffold that feeds the audit:

- **Hint-by-convention (today).** Conflict detection runs, a count of
  `pending` conflicts is printed as a yellow note at run start, and the
  internal-docs scaffold is injected into review and correction
  unconditionally. Arbitration is an out-of-band interactive command the
  operator may or may not ever run. Nothing structurally prevents a scaffold
  written from buggy code (which describes the bug as the intended contract)
  from becoming the auditor's ground truth.
- **Gated injection, enforced.** In `full` mode the internal-docs scaffold
  cannot reach the axes while it carries unresolved (or undetected) conflicts
  with the external reference. The pipeline either injects the ratified view
  (arbitrated doc-wins fragments plus the conflict-free remainder) or, when no
  ratification exists, injects no internal scaffold at all and the audit runs
  on code plus the authoritative external reference only. The auditor is never
  fed an unratified code-derived narrative.

**Gated injection is chosen.** Rationale, echoing doc 11 and 14 §1: a rule is
enforced by the single code path everything is obliged to take, plus a gate
that fails closed when ratification is absent. The hint is not a barrier; a
yellow note does not stop a context-rot loop. The owner's rule is a gate, and
a gate that is only a printed string is not implemented.

The unattended fallback (§7) was the one open parameter, because arbitration
is human-interactive and bench / CI / cloud runs have no operator. **The owner
has decided it: option B, fail-closed per fragment.** An uncontested fragment
(no open or undetected conflict against the external reference) is kept;
only a fragment under an open conflict is excluded. The contract is now fully
specified; §7 records the decision and its one hard prerequisite (D2 / PR 2).

## 2. Diagnosis (grounded)

Verified at HEAD `7010155` (code tip), branch `orchestration-sink-convention`,
post doc-14 closure and doc-15 PR 2a, on the slot-engine bench fixture
(`../anatoly-bench/catalog/slot-engine`, run `2026-05-18_175524`, v32). The
slot-engine README states the correct contract (theoretical RTP 95%, 5% house
edge against the player); the code carries an intended-looking `*1.05`
house-edge inversion and an `applyWildBonus` double-stack
(`basePayout*(1+wildCount)*2**wildCount`); the scaffolder, reading that code,
writes an internal doc that presents both as the spec.

**A full conflict-resolution system already exists; this contract wires it,
it does not build it.** The machinery in place: detection produces
hash-anchored `pending` conflicts persisted in `doc-conflicts.yaml`; each
carries auto-derived arbitration signals (`derivePresumption` -> doc-stale /
code-drift / unknown, git timestamps, test-coverage heuristic); the
`anatoly docs arbitrate` wizard records doc-wins / code-wins / skip / defer
verdicts with incremental save, plus `--list` and `--review`;
`applyResolvedVerdicts` promotes a verdict to `applied`/`skipped` on the next
run; `markStaleEntries` re-opens an entry to `pending` when the code hash
moves; doc-wins is consumed by `loadArbitratedFragments` and code-wins by
`doc-stale-reference.ts`. The defects below are not "resolution is missing".
They are: the system's `pending` state gates no injection (D1); the system is
fed a comparison that cannot see the bug class (D2); and the system's
resolution loop has only a human trigger, so it never closes in an unattended
run, though its own signal layer (`presumption`/`signals`/
`applyResolvedVerdicts`) is already the substrate an unattended policy would
reuse (D3, §7). The contract reuses every one of these pieces.

| # | Defect | Grounded evidence |
|---|---|---|
| **D1** | **No injection gate; the rule is a hint.** `countPendingDocConflicts` is read once and only to print a yellow note; it gates nothing. The internal-docs scaffold tree and dir are threaded into the handoff (and thence review/correction) unconditionally. `loadArbitratedFragments` only *adds* the resolved doc-wins fragments on top; it never *blocks* the raw unratified scaffold. | [setup.ts:425-433](../../src/core/orchestration/phases/setup.ts#L425) (hint only), [setup.ts:481-482](../../src/core/orchestration/phases/setup.ts#L481) (`handoff.internalDocsTree`/`internalDocsDir` set unconditionally), [pipeline.ts:71-86](../../src/core/orchestration/pipeline.ts#L71) + [pipeline.ts:275](../../src/core/orchestration/pipeline.ts#L275) (`loadArbitratedFragments` keeps `verdict==='doc-wins' && status==='applied'`, additive only) |
| **D2** | **Detection is structurally blind to body-level bugs.** The 3-way detector compares REFERENCE_DOCS, INTERNAL_DOCS and a CODE_SURFACE that is exported-symbol **signatures only** (kind, name, line range): no bodies, no numeric constants, no logic. A `*1.05` / `2**wildCount` divergence lives in a body the comparison never sees. It can only fire when the scaffold's *prose* textually contradicts the reference's *prose*; a scaffold generated from buggy code typically narrates the bug coherently, so no textual contradiction exists. Detection is also a single one-shot LLM judgment with no invariant grounding, and `enrichDetectedConflict` silently drops items (reference_path off the allow-list, file over the size cap, anchor unresolved). | [doc-coherence-3way.ts:24-44](../../src/core/documentation/conflict/doc-coherence-3way.ts#L24) (`buildCodeSurfaceSummary`: exported signatures only), [doc-conflict-detector.ts:456-458](../../src/core/documentation/conflict/doc-conflict-detector.ts#L456) (the three inputs), [doc-conflict-detector.ts:294-324](../../src/core/documentation/conflict/doc-conflict-detector.ts#L294) (silent `return null` drops) |
| **D3** | **The existing resolution loop has only a human trigger; a co-location footgun, not a wipe.** The resolution system is real and complete (above); its closing step is the interactive `anatoly docs arbitrate` wizard, which is the **only** writer of a verdict. There is no automated/unattended trigger that exercises that loop. In a bench / CI / cloud / `--defaults-settings` run there is no operator, so every conflict stays `pending` forever and, absent D1's gate, the unratified scaffold is injected anyway. The signal substrate for an unattended policy already exists (`derivePresumption`, `signals`, `applyResolvedVerdicts`); §7 is a wiring decision, not new machinery. Secondary, store independence: `doc-conflicts.yaml` is written atomically and (confirmed) survives normal scaffold regeneration (per-file writes preserve existing files), but it lives in the **root** of `state/internal-docs/` alongside the regenerated fragments, so the explicit `anatoly docs scaffold internal` rebuild (`rmSync(dir, recursive)`) destroys the arbitration ledger as a side effect. | [docs-arbitrate.ts:69-80](../../src/commands/docs-arbitrate.ts#L69) + [docs-arbitrate.ts:163-280](../../src/commands/docs-arbitrate.ts#L163) (`applyVerdict` only called from the interactive wizard; `--list`/`--review` do not auto-resolve), [doc-conflict-detector.ts:102-116](../../src/core/documentation/conflict/doc-conflict-detector.ts#L102) (`derivePresumption` sets only `signals.presumption`, never `verdict`), [doc-conflict-store.ts:17-19](../../src/core/documentation/conflict/doc-conflict-store.ts#L17) (store path = `state/internal-docs/` root), `docs.ts:263` (`rmSync(dir, recursive)` on explicit internal rescaffold) |

One sentence: a complete conflict-resolution system exists but the owner's
anti-context-rot rule that should consume its state is unimplemented (D1), the
system is fed a comparison that cannot see the bug class that matters (D2),
and its resolution loop only closes when a human runs the wizard (D3); the net
is the exact loop the rule forbids, where a scaffold built from buggy code
becomes the auditor's spec and the auditor duly reports the bug as correct.
The work is to wire and feed the existing system, not to build one.

This is distinct from the wild.ts pipeline silent-drop (fixed `54ff95c`,
doc 15) and from the correction-axis prompt question: with a clean internal
view the correction axis does detect (INV-RTP). The binding constraint is the
unratified scaffold, not the axis prompt.

## 3. The contract

For `full` mode (the only mode that scaffolds an internal doc and runs
detection; `off`/`lite` are out of scope and unchanged):

1. **Ratification barrier.** The internal-docs scaffold reaches review and
   correction **only** as the ratified view: the union of (a) arbitrated
   `doc-wins` fragments and (b) scaffold fragments with no open conflict
   against the external reference. A scaffold fragment under an unresolved or
   undetected conflict is not in the auditor's context.
2. **Fail closed, per fragment (owner decision: §7 option B).** Exclusion is
   at fragment grain: a fragment under an open conflict (`pending`, or no
   detection ran for it) is **excluded**, and **neither side is injected** for
   it: not the scaffold fragment, and not the reference excerpt (the reference
   is the unratified other side of an open conflict; using it as authoritative
   would itself break "only resolved content may be used"). The audit sees the
   conflict-free internal scaffold plus the conflict-free remainder; for a
   resolved `doc-wins` + `applied` conflict (human arbitration only, never in
   unattended/bench) the now-ratified reference excerpt is injected in place of
   the superseded fragment. The default is exclude, not include. This trades a
   residual "undetected conflict" risk for keeping the uncontested scaffold's
   value, and therefore depends on detection being strong (D2 / §6 PR 2,
   validated post `cabd123`).
3. **Surface, do not silently drop (owner decision).** An unresolved
   conflict is **folded into the correction axis of its anchored reviewed
   symbol as an explained `NEEDS_FIX`** (it lives where every finding lives,
   `axes/<axis>/shard.N.md`, so the existing bench parser+scorer credit it
   with no SPEC/scorer change). The `detail` states it is a code↔reference
   conflict, quotes both sides, and points at `anatoly docs arbitrate`: the
   tool flags the contradiction transparently, while arbitration still
   decides which side is authoritative and the `doc-conflicts.yaml` store is
   left intact for that. Safety-net + dedupe: a symbol the correction axis
   already flagged is left untouched (no double-count), so the fold only
   adds value on runs where the volatile axis missed it. A conflict whose
   symbol is not in the reviewed set falls back to a human-readable report
   section only. This is the repeatable, scorable value of detection.
4. **Detection must see the bug class.** Conflict detection's code input is
   extended past signatures so a body-level numeric/logic divergence between
   the scaffold's claimed behavior and the reference's stated contract is
   detectable (§6 PR 2). The detector stops being a doc-prose-vs-doc-prose
   comparator. (Realized PR 2b/2c: store-vector cosine pairing + single-turn
   inversion verification; validated post `cabd123`.)
5. **Unattended fallback is explicit, not accidental.** With no operator, the
   mode's behavior is the owner-chosen policy of §7, applied deterministically
   and logged, never "inject anyway because the note was only a hint".
6. **The ledger is durable and independent.** The arbitration store does not
   live where a scaffold rebuild can delete it; a verdict, once set, is not
   lost by a routine rescaffold.

## 4. The enforcement mechanism

- **One gate, in the policy table.** Injection of the internal-docs scaffold
  becomes a predicate in the centralized gate table (`gates.ts`, the doc 14
  PR 5 structure), not an unconditional `handoff.internalDocsTree = ...` in
  setup. The spine reads the gate; the gate's inputs are doc mode, pending
  conflict count, and detection status. setup stops threading the raw tree
  unconditionally; it threads the ratified view the gate produces, or nothing.
- **Ratified-view assembly is the single producer.** The pre-review step that
  today calls `loadArbitratedFragments` (additive) becomes the producer of the
  whole injected internal view: doc-wins fragments plus conflict-free
  fragments, minus everything pending/undetected. There is exactly one place
  that decides what internal content the auditor sees.
- **Detection input widened at the seam.** `buildCodeSurfaceSummary` (or a
  sibling used only by the conflict detector) gains body-level evidence for
  the symbols a fragment claims behavior about, scoped to stay within the
  existing `DETECTION_PROMPT_TOKEN_BUDGET` batching. The coherence-review
  surface (a different consumer) is not forced to change in lockstep.
- **Store relocated and guarded.** `doc-conflicts.yaml` moves out of the
  scaffold-fragment root into a sibling location a fragment rebuild does not
  touch (for example `state/doc-conflicts.yaml` or
  `state/arbitration/doc-conflicts.yaml`), with a one-time migration read of
  the old path. The explicit-rescaffold `rmSync` no longer intersects it.
- **Binding invariant test.** A hermetic test asserts: in `full` mode with a
  `pending` conflict on a fragment, that fragment's text is absent from the
  assembled review/correction context, and the doc-wins arbitrated fragment
  for a resolved conflict is present. The build fails if an unratified
  fragment reaches the auditor.

## 5. Acceptance invariants (testable)

1. `full` mode, one fragment with a `pending` conflict: the assembled
   review/correction internal context contains neither that fragment's text
   nor a paraphrase anchor from it (hermetic; assert on the built context
   string, no LLM).
2. `full` mode, same conflict arbitrated `doc-wins` + `applied`: the
   arbitrated reference excerpt is present and the superseded scaffold
   fragment is absent.
3. Detection fixture: a scaffold fragment claiming behavior that contradicts
   the reference only in a numeric constant present in the body but not in any
   signature is reported as a conflict (proves D2 closed; hermetic detector
   fixture, replayed LLM, never a live call).
4. Unattended run (no TTY, `--defaults-settings`): the §7 fallback policy is
   applied and emitted on the structured channel; no unratified fragment is
   injected; the run does not block on a wizard.
5. A routine `anatoly run` (scaffold regenerated) followed by another run:
   a verdict set between them is still present (store durability); an explicit
   `anatoly docs scaffold internal` does not delete the ledger.
6. Bench global F1 within the established run-to-run noise band of the
   pre-change baseline at every PR boundary, with the correction-axis F1
   measured specifically on slot-engine in isolation (the volatile axis; band
   per [project_unit_harness_doc14] / doc 15, baseline F1 0.6729). The
   ratified-view change is behavior-relevant by intent; "no regression" means
   inside the noise band, and the target is correction-axis recovery on the
   buggy fixtures, not byte-identical output.
7. `full` mode, a `pending` conflict whose anchored symbol was reviewed and
   is **not** already a correction defect: that symbol's `correction`
   becomes `NEEDS_FIX` with a `detail` that names the conflict, quotes both
   sides, and points at `anatoly docs arbitrate` (so it lands in
   `axes/correction/shard.N.md` and the existing bench scores it against the
   catalogued expectation, no SPEC/scorer change). Dedupe: a symbol already
   a correction defect is left untouched (no double-count). Symbol not in
   the reviewed set: falls back to the report section only. Hermetic;
   assert on the mutated review model, no LLM.

## 6. PR sequence (ascending risk, per-PR gate)

- **PR 0 (this document, done).** The contract and the grounded diagnosis at
  `7010155`. No code. §7 decided (B). §3 validated by the owner 2026-05-18.
- **PR 1 (done) — store durability and independence (behavior-preserving).**
  `doc-conflicts.yaml` relocated from `state/internal-docs/` to the
  `.anatoly/state/` root (`conflictsFilePath`); `loadDocConflicts`
  migrate-on-reads the pre-doc-16 path and writes through to the durable
  location; the explicit-rescaffold `rmSync(state/internal-docs)` no longer
  intersects it. All consumers route through `loadDocConflicts`, so the change
  is centralized; returned data is byte-identical. Gate met: typecheck clean,
  full suite 3048 pass / 0 fail (spine/handoff goldens included), lint clean,
  6 new durability + migrate-on-read tests (invariant 5). No bench needed
  (provably no audit-input change), per the doc-15 PR-1 precedent.
- **PR 2 (code done, bench-pending) — detection sees the bug class
  (behavior-relevant, detector only).** Approach corrected by grounding +
  owner: the original "scope body-level CODE_EVIDENCE to a fragment's source
  file" is unbuildable (scaffolder pages are topic/section pages, no
  machine-readable source anchor: `PageDef{path,title,description,section,
  hint}`, doc-scaffolder.ts:26/205), and a segment-comparison primitive
  already exists. PR 2 therefore **reuses `smartChunkDoc`** (src/rag/
  doc-indexer.ts:514, H2/H3 split + same-paragraph accumulation + neighbour
  merge + sub-50-char discard) to segment **both** REFERENCE_DOCS and
  INTERNAL_DOCS by section before comparison (new `segmentForDetection`,
  doc-conflict-llm.ts), so a localised inversion is judged
  section-against-section instead of skimmed in a whole-page prose diff;
  `DETECTION_SYSTEM_PROMPT` now makes **inversions** (reversed sign /
  direction / ratio / comparator / beneficiary / unit) the highest-priority
  divergence. No code bodies (owner: dropped); the internal doc, generated
  from buggy code, already encodes the buggy value. Segmentation is done
  upstream in `detectNewConflictsViaLlm` so the token-budget batcher stays
  accurate; `buildDetectionUserMessage` stays a pure renderer (existing
  assertions unaffected). The lone silent `return null` in
  `enrichDetectedConflict` (unreadable anchor file) is now logged
  (doc-15-aligned, no silent miss). Gate met: typecheck clean, full suite
  3053 pass / 0 fail, lint clean, 5 new tests incl. the D2 input-guard
  (assembled prompt is section-segmented and carries the inversion rule) and
  an inversion round-trip; no live LLM.
- **PR 2 bench (run `pr2-doc16`, VM): INCONCLUSIVE.** global F1 0.627
  (noise band, low side) but the PR-2 path never executed: the single
  whole-corpus agentic detection call aborted at the 120s
  `DETECTION_TIMEOUT_MS` with zero model output. Transcript diff proved it
  pre-existing (v32 prompt 123 KB, same `## User`→`## Error`, no
  `## Assistant`) and **not** caused by PR-2 (PR-2 prompt smaller, 100 KB).
  Root cause: a single ~25-30k-token agentic JSON call to Sonnet never
  returns within 120s. The monolithic shape is the defect.
- **PR 2b-i (committed `0670941`) — first cosine-pair cut. Bench
  INCONCLUSIVE.** Removed the monolith (timeout fixed: doc-conflict-update
  11.4 s vs 120 s-abort; global F1 0.6819 > ref, no regression), but
  detection matched **0 pairs**: a `vectorStorePairMatcher` joined store
  hits back to a locally re-segmented `smartChunkDoc` section by
  `filePath#heading`; the store's `filePath` is the projectRoot-relative
  `.anatoly/state/internal-docs/...` while the local relPath omitted that
  prefix → every hit dropped. (Earlier "Haiku-title" theory was wrong; the
  store keys sections by the real `smartChunkDoc` heading, verified.)
- **PR 2b (code done, bench-pending) — store-only pair verification.**
  Owner's insight: the vectors **and** addresses are already persisted;
  the full passage text is already in the **doc chunk cache**
  (`doc_chunk_cache_*.json`: `{filePath → {sha, sections:[{heading,
  embedText, content}]}}`, untruncated, keyed exactly as the store rows).
  So: no re-embed, no re-chunk, no local join, no lossy 400-char `summary`.
  New `VectorStore.listDocSectionVectors(source)` enumerates stored
  doc-section rows + their `nlp_vector`; for each reference row,
  `searchDocSections(refVec, k, 0.5, 'internal')` ranks internal sections
  on the already-stored vectors; passage text + H2 neighbour for both
  sides resolved from the chunk cache via new `loadDocSectionTexts`
  (suffix-agnostic glob, exported from rag); dedupe (best per internal);
  LLM-verify only the suspect pairs in ≤10-pair batches
  (`buildPairDetectionUserMessage` + the PR-2 inversion system prompt) —
  each call tiny, the 120 s timeout a never-hit safety net. Matcher
  injected (`DocPairMatcher = () => Promise<CandidatePair[]>`): production
  `storePairMatcher`; no `vectorStore` (RAG off) → detection skipped with
  a log (no in-memory re-embed; the store-only design has no cheap
  fallback, accepted scope note); tests inject a deterministic stub (no
  store/embed/LLM). `vectorStore` threaded from the pipeline
  `doc-conflict-update` site. Gate met: typecheck + lint clean, full suite
  **3070 passed / 0 failed** (orchestration goldens 79/0, documentation +
  rag 637/0, new `doc-conflict-pairing` + `loadDocSectionTexts` +
  `buildPairDetectionUserMessage` tests, migrated detector/hardening
  tests). **Tracked follow-up (not silent debt):** the now-unused monolith
  helpers `buildDetectionUserMessage` / `batchFragmentsByTokenBudget` /
  `segmentForDetection` (+ their barrel exports/tests) are dead and slated
  for a scoped cleanup PR; left compiling+green here to keep PR 2b focused.
  Also tracked separately: replace the indexing-side truncated `summary`
  with a section anchor + chunk-size tolerance (RAG-layer PR, owner-raised).
- **PR 2b bench (pr2bs-doc16, `ca5793f`): pairing WORKS, abort ROOT-CAUSED.**
  The store matcher produced pairs and a real `pairs-1` LLM batch was made
  (the 0-pairs defect is fixed). But that `router.agenticQuery` call again
  produced **zero `## Assistant` output and aborted at the 120 s
  `DETECTION_TIMEOUT_MS` — with a 23 KB prompt** (PR-2 was 100 KB, v32
  123 KB; all identical). This conclusively kills the prompt-size
  hypothesis: the bottleneck is the Claude Code **agentic subprocess
  itself**, not prompt size. (Also: `c76db4b` had swept an unrelated
  parallel-work `doc-sources` barrel export into `rag/index.ts` →
  clean-checkout build break → corrective `ca5793f`; the parallel
  doc-sources/orchestrator/events work is left untouched/uncommitted.)
- **PR 2c (code done, bench-pending) — single-turn query path.** Detection
  is a no-tool structured-JSON extraction; it never needed the agentic
  path. Replace `router.agenticQuery(...)` with `runSingleTurnQuery(params,
  DetectionResponseSchema)` — the exact `transport.query` seam all seven
  axes use successfully every run (no agentic subprocess, no 120 s hang).
  `result.data` is schema-validated (drops the manual
  `parseDetectionResponse`); cost folded into the rollup from the result's
  numeric fields (doc-15 unchanged); per-batch transcript preserved via
  `conversationDir`/`conversationPrefix`; the 120 s timeout is now a true
  safety net. Tests spy `runSingleTurnQuery` (the `vi.spyOn(evaluation,
  'runSingleTurnQuery')` pattern axes already use) instead of mocking
  `agenticQuery`; the obsolete temperature assertion is retired (single-turn
  has no temperature param). Gate met: typecheck + lint clean, full suite
  **3070 passed / 0 failed** (orchestration goldens, documentation + rag,
  conflict suites incl. migrated detector/hardening). **Bench (owner-run)
  at the PR-2c tip is the run that finally exercises detection
  end-to-end** (measures D2 — is the RTP/wild inversion caught — and
  confirms the call now returns). PR 3 must not ship B's keep-uncontested
  until that bench is green (§7 hard prerequisite).
- **ROOT CAUSE of the "detection times out" symptom — found, NOT in
  doc 16 code.** An instrumented run + the SDK's own `~/.claude/debug`
  log proved: on the **first `query()` of any run** the bundled `claude`
  CLI bootstraps the official plugin marketplace via
  `git clone anthropics/claude-plugins-official` (SSH URL first, built-in
  `timeout=120000ms`). On the bench VM (IPv6 enabled-but-blackhole, a WSL
  networking race) the SSH attempt stalls the full 120 s; whatever unit
  makes the run's first SDK call wears the abort — structurally
  doc-conflict-detection (it runs at `doc-conflict-update`, before
  `review`). Every later call is ~3.6 s. The standalone repro proved the
  detection code itself is correct (same call, **21 s, 1 conflict**). So
  PR 2 / 2b / 2c were never the cause; the prompt-size / agentic /
  single-turn / matcher hypotheses were all symptom-chasing.
- **Fix (applied, owner-directed): disable the dead-weight SDK bootstrap.**
  anatoly drives the SDK purely programmatically (explicit allowedTools,
  bypassPermissions) and never uses plugins, the marketplace, or the
  auto-updater. `anthropic-transport.ts` `query()` options now pass
  `env: { ...process.env, CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:
  '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER:
  '1' }` for **every** SDK call (the SDK's `env` replaces `process.env`, so
  it is spread first). This removes the first-call marketplace git-clone
  run-wide, independent of VM network hygiene; defense-in-depth with the
  bench-VM WSL IPv6 hardening (`/etc/wsl.conf` `[boot]` re-assert). Gate:
  typecheck + lint clean, transport+conflict+orchestration 362/0, full
  suite 3069 pass (the lone fail is the recurring unrelated cache-meta
  perf flake). Re-bench PR 2b/2c expected clean: detection ~21 s,
  INV-RTP caught (INV-WILD remains the separate deferred design matter —
  reference↔internal cosine cannot reach it).
- **PR 3 — the gate, a TWO-effect producer (behavior-relevant, the core).**
  **Split by ascending risk (the schema forces it): `DocConflict` carries no
  internal-doc fragment identity (anchor = code file/symbol; reference =
  reference doc), so Effect 2 is buildable now from existing fields while
  Effect 1 genuinely needs the conflict↔fragment section mapping.**
  - **PR 3a (DONE, committed) — Effect 2, surface.** New
    `DocConflictFindingSchema` (`kind:'doc_conflict'`, schemas/review.ts);
    `loadPendingConflictsAsDocConflicts` (mirrors
    `loadCodeWinsAsStaleReferences`, filters `verdict:'pending'` +
    status active/stale); a human-readable `renderDocConflictSection`
    folded into `combinedDivergenceSection`.
    **Owner decision (supersedes the earlier separate-artifact +
    scorer-contract plan, which was over-engineered): a finding lives where
    every finding lives — `axes/<axis>/shard.N.md`.** So
    `applyPendingConflictsToReviews` (reporter.ts, run in `generateReport`
    between `loadReviews` and `aggregateReviews`) folds each unresolved
    conflict into the **correction axis** of its anchored reviewed symbol
    as an **explained `NEEDS_FIX`** (the `detail` states it is a code↔
    reference conflict, quotes both sides, and points at
    `anatoly docs arbitrate`). It is then a normal finding the **existing**
    bench parser+scorer credit against the catalogued correction
    expectation (e.g. INV-RTP) with **zero anatoly-bench / SPEC change**.
    **Safety-net + dedupe:** a symbol whose `correction` is already a defect
    is left untouched (no double-count under the bench's bipartite
    matching), so the fold only adds value on the runs the volatile
    correction axis missed. The `doc-conflicts.yaml` store is left intact
    for `anatoly docs arbitrate` (surface + flag, while arbitration still
    decides which side is authoritative; the `detail` is explicit it is a
    conflict, not a blind code-fault claim). A conflict whose file/symbol is
    not in the reviewed set falls back to the markdown section only (no
    fabricated symbols). Gate met: typecheck + lint clean, full suite
    3076 pass / 0 fail, +6 hermetic tests (surface filter incl. invariant-7
    essence, defensive, render, fold, dedupe, symbol-miss). Goldens
    unaffected (hermetic, no doc-conflicts.yaml ⇒ 0 folded). This is
    behavior-relevant: a re-bench now measures whether INV-RTP is credited
    via the fold on runs where correction missed it (the safety-net value).
  - **PR 3b (pending design) — Effect 1, de-poison.** The `gates.ts`
    predicate + ratified-view producer that excludes the contested scaffold
    fragment from review/correction context (no side injected for an
    unresolved conflict; reference excerpt only on resolved doc-wins).
    Behavior-relevant + unproven payoff; its design crux is the
    conflict↔fragment mapping (section grain, reusing PR-2b
    `smartChunkDoc`+cosine). Owner decision before building, given the
    honest thin/unproven F1 upside vs the correction-axis lever.
  Detection is now validated end-to-end (post `cabd123`, run pr2cfix-doc16:
  doc-conflict-update 7.8 s, the INV-RTP inversion correctly detected), so
  the §7 hard prerequisite is met and the transitional-A caveat is lifted:
  B-per-fragment ships directly. Replace the unconditional scaffold
  threading ([setup.ts:481-482](../../src/core/orchestration/phases/setup.ts#L481))
  with a ratified-view producer behind a `gates.ts` predicate (the doc-14
  PR 5 table the spine reads). For each scaffold fragment the gate has two
  effects, driven by the `doc-conflicts.yaml` state:
  - **Effect 1, de-poison (context).** A fragment under a `pending` or
    undetected conflict is **excluded** from the review/correction context,
    and **neither side is injected**: not the scaffold fragment, and not the
    reference/README excerpt either. The reference is the *unratified other
    side* of an open conflict; injecting it as authoritative would violate
    the rule (only resolved content may be used). So an unresolved conflict
    yields code plus the conflict-free remainder only. The reference excerpt
    is injected **only** for a conflict resolved `doc-wins` + `applied`
    (then it is ratified, not "in conflict"): that path requires human
    `anatoly docs arbitrate` and so never fires in unattended/bench. A
    `code-wins` + `applied` conflict emits a `doc_stale_reference` (existing
    path), the reference is not injected. Conflict-free fragments pass
    through unchanged. setup threads this ratified view, never the raw tree.
  - **Effect 2, surface (finding).** An unresolved conflict is not silently
    dropped (doc-15 no-silent-drop). It is **emitted as a `doc_conflict`
    finding** carrying the detector's `divergence` text and the
    `file`/`symbol` anchor (e.g. INV-RTP: "reference = 5% house edge against
    the player; code multiplies payout by 1.05 in the player's favour; the
    two disagree on the direction"). The tool reports the contradiction; it
    does **not** adjudicate which side is wrong (that is arbitration's job).
    Reuse the existing divergence path: the `DocDivergence` /
    `DocStaleReference` schemas ([schemas/review.ts]) and
    `aggregateDivergences` / `renderDivergenceSection`
    ([reporter.ts:2258](../../src/core/reporting/reporter.ts#L2258), the
    "Divergences code ↔ reference" report section); add a pending
    `doc_conflict` kind through that pipe. Incremental, not a new subsystem.
  This is what makes doc-16 worthwhile: detection (now reliable) yields a
  **repeatable surfaced finding** regardless of the volatile correction
  axis, instead of only a silent context removal whose payoff was unproven.
  **Hard sub-decision (the design crux of PR 3): the conflict↔fragment
  mapping.** A `doc-conflicts.yaml` entry anchors to `{file, symbol}` (e.g.
  `src/engine.ts#computePayout`); scaffold fragments are **topic/section
  pages**, not one-page-per-file (same obstacle PR 2 hit). So "exclude the
  fragment that documents `computePayout`" has no trivial deterministic map.
  Options: (a) page grain (coarse, over-excludes a whole topic page for one
  contested symbol); (b) **section grain, reusing the PR-2b machinery**:
  `smartChunkDoc` segments + the cosine pairing already relate a conflict's
  reference passage to internal section(s), so exclude/cite at that section.
  (b) is the consistent choice and reuses built code; it is the central
  thing PR 3 must specify and test.
  **Scorer-contract caveat (stated, not hidden).** INV-RTP is catalogued
  `axis: correction / NEEDS_FIX` (anatoly-bench `SPEC.md`). A `doc_conflict`
  finding will **not** auto-match that expectation until the anatoly-bench
  SPEC/scorer accepts `DOC_CONFLICT` as a valid way to flag it. So PR 3's
  product/user value (a reliable surfaced contradiction) is unconditional;
  the **measured bench-F1 credit is gated on a separate scorer-contract
  change in the sibling repo** and must not be assumed. PR 3 still does
  nothing for the 5 non-doc correction misses (structurally out of scope).
  Gate: invariants 1, 2 and a new 7 green; full suites + goldens (hermetic,
  doc-conflict skipped, so its own bench, per doc-15 PR 1); bench with
  correction-axis and the new `doc_conflict` finding both measured on
  slot-engine.
  - **New invariant 7 (testable, hermetic):** `full` mode, one fragment
    with a `pending` conflict — that fragment's text is absent from the
    assembled review/correction context **and** exactly one `doc_conflict`
    finding is emitted carrying the divergence text + the conflict's
    file/symbol anchor; assert on the built context string and the report
    model, no LLM.
- **PR 4 — unattended fallback = B, made explicit (behavior-relevant).**
  B is already the PR 3 behavior in both attended and unattended runs (and
  PR 2 is bench-proven post `cabd123`, so there is no transitional-A left to
  remove). PR 4 is the no-operator hardening: deterministic application with
  no wizard block, and the chosen policy plus every emitted `doc_conflict`
  finding surfaced on the structured channel. Gate: invariant 4 green;
  bench (the fallback is what bench/CI actually exercise, so this is the PR
  whose bench number is the representative full-mode-unattended figure).
- **PR 5 — binding invariant fold-in.** Promote invariants 1 to 5 into the
  CI invariant set so a future change that injects an unratified fragment
  fails the build, mirroring the doc-15 PR-2d enforcement-as-proof shape.
  Gate: the invariant test green on a hermetic run; bench unchanged.

Each PR updates the matching line in this document and in
[15](./15-Observability-Enforcement-Contract.md) §2 (the doc-conflict row) in
the same PR, never after, per the doc 11/14/15 convention.

## 7. Owner decision: the unattended fallback (DECIDED — B)

Arbitration is human-interactive; bench, CI, cloud, and `--defaults-settings`
runs have no operator, so `pending` is the permanent state there and the
fallback policy *is* the effective full-mode behavior for every automated
consumer (including the bench that gates this work).

**Decision (owner, 2026-05-18): option B, fail-closed per fragment. Standing
default unless re-contested.** Inject doc-wins arbitrated fragments plus the
conflict-free remainder; exclude only the fragments under an open or
undetected conflict. The rule in the owner's words: if a fragment is not
contested, it is kept. B is the standing behavior in attended and unattended
runs alike (the gate is fragment-grained, not a global on/off), so there is no
mode-dependent divergence to reason about.

The options considered, for the record:

- **(A) Fail-closed to external + code only.** Any open conflict: inject no
  internal scaffold at all. Strongest guarantee but discards the entire
  uncontested scaffold whenever one conflict is open. **Not chosen** (too
  coarse: it punishes the conflict-free majority for one contested fragment).
- **(B) Fail-closed per fragment. CHOSEN.** Exclusion at fragment grain;
  uncontested fragments retained. Keeps the value of the conflict-free
  scaffold while still never feeding the auditor a contested fragment.
- **(C) Unattended auto-arbitration by presumption.** Auto-resolve via
  `derivePresumption`. **Not chosen as default**: it makes an unsupervised
  doc-vs-code judgment the owner's rule reserves for the user. Remains a
  documented opt-in for a future epic; not in this PR sequence.

**Hard prerequisite, stated plainly.** B's safety rests on "no detected
conflict" being trustworthy, which is exactly what D2 breaks today
(signatures-only detection cannot see a body-level bug, so a buggy fragment
reads as uncontested and B would keep it). Therefore **PR 2 (detection sees
the bug class) must land and be bench-proven before PR 3/4 ship B's
keep-uncontested behavior**; until PR 2 is proven, the gate behaves as A
(exclude on any open conflict *and* whenever detection cannot vouch for a
fragment) as the transitional safe state. The residual "undetected after PR 2"
risk is accepted by this decision and is what invariant 6's bench measures.

## 8. Why this is not a relitigation

This does not reopen doc 14's declined PR 4c/6 or doc 15's scope. Doc 15
delivered observability (the doc-conflict unit's cost is now visible) and
explicitly scoped *out* what that unit's output does to the audit. This
contract is that out-of-scope behavior-correctness layer: a grounded, live
correctness defect (an internal doc derived from buggy code is fed to the
auditor with no ratification barrier, demonstrably suppressing real findings
on the slot-engine fixture), fixed by the owner's own stated rule, enforced by
a single gate plus a binding invariant rather than a printed note. It uses the
gate table doc 14 built and the cost visibility doc 15 added; it rebuilds
neither.
