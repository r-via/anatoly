# Orchestration Remediation Plan (Strategy B)

> Status: this document is the **execution contract** for closing the gap that
> [10-Orchestration-Runtime.md](./10-Orchestration-Runtime.md) documents. Doc 10
> describes what is true today and what diverges from intent. This document
> decides **how the divergence is closed** and in what order. It is binding:
> once a PR below lands, the corresponding line in doc 10 must be updated in the
> same PR, never after.
>
> Constraint set by the owner, verbatim in intent: *no debt is acceptable on the
> orchestrator; it must work correctly.* Every step here is therefore
> behavior-preserving and test-gated, or it does not ship.

## 1. The decision

Two remediation strategies were on the table.

- **Strategy A (wire the Epic 56 scaffolding).** Construct the gateway, dispatch
  the registry, instantiate the exchange, route the live pipeline through them.
  This replaces a procedural spine that *works* with a generic mechanism that
  has never executed. Under a zero-debt constraint this is the higher-risk path:
  it trades a known-correct ugly thing for an unproven elegant one.
- **Strategy B (extract the live spine, delete the dead scaffolding).** Move the
  real orchestration out of `run.ts` into a real module, keep its behavior
  identical, and delete the registry/executor/exchange that nothing invokes.

**Strategy B is chosen.** The dead scaffolding is deleted in the first PR, not
carried as backlog. Rationale: a contract whose central mechanism has zero
runtime callers is not a contract, it is a design proposal mislabelled as one.
Keeping it green-tested but unwired is exactly the debt the constraint forbids.

## 2. Diagnosis (grounded)

Verified at HEAD `edc094b`, branch `anatoly-self-audit`.

| Fact | Measure |
|---|---|
| `src/commands/run.ts` size | **3,360 lines** (a command handler, not an orchestrator) |
| Phase logic actually executed | 7 large functions defined **inside** `run.ts`: `runSetupPhase` ([1322](../../src/commands/run.ts#L1322)), `runDocLlmPhase` ([1749](../../src/commands/run.ts#L1749)), `runDocBootstrap` ([1991](../../src/commands/run.ts#L1991)), `runDocUpdate` ([2046](../../src/commands/run.ts#L2046)), `runRagPhase` ([2180](../../src/commands/run.ts#L2180)), `runReviewPhase` ([2465](../../src/commands/run.ts#L2465), the hot path), `runReportPhase` ([2861](../../src/commands/run.ts#L2861)) |
| Orchestration spine (sequence + gates + handoff) | inline at [run.ts:918-1231](../../src/commands/run.ts#L918) |
| Only live link into `src/core/orchestration/` | one line: `import { runPhase }` ([run.ts:96](../../src/commands/run.ts#L96)) |
| Rest of the orchestration module | `executor.ts`, `exchange.ts`, `registry/` (33 files): **zero runtime callers** (grep-confirmed, source minus tests) |

In one sentence: the orchestrator has no orchestrator. The code that decides
what runs, in what order, under what gate, with what data is inlined procedural
logic in a command handler. Beside it sits a generic cathedral
(registry / executor / exchange) wired to nothing. `runPhase`
([run-phase.ts](../../src/core/orchestration/run-phase.ts)) is the only honest
piece: a boundary wrapper that works and is genuinely tested.

`RunContext` ([run.ts:141](../../src/commands/run.ts#L141)) is a god object,
mutated at 40+ sites. **Only a small subset is real inter-phase handoff** (see
§4). Conflating that subset with runtime/UI/lifecycle fields in one mutable bag
is the primary trap of the extraction, and the reason this is not a simple
"move the functions" job.

## 3. The four interleaved concerns

The spine at [run.ts:918-1231](../../src/commands/run.ts#L918) is not pure
orchestration. It interleaves four concerns that must be **separated**, not just
relocated:

| Concern | Current example | Destination |
|---|---|---|
| Orchestration (sequence + gates) | `if isFirstRun && isDocAxisActive -> runPhase('bootstrap-doc')` ([987](../../src/commands/run.ts#L987)) | `orchestration/pipeline.ts` |
| Phase implementation | the inline `refinement` closure, ~110 lines ([1093-1205](../../src/commands/run.ts#L1093)) | `orchestration/phases/refinement.ts` |
| UI / presentation | `PipelineState`, `ScreenRenderer`, `completeTask(...)` | constructed in `run.ts`, passed to the pipeline through a port, never inlined in phase logic |
| Process lifecycle | `acquireLock`, `SIGINT`, `activeAborts`, `releaseLock` | stays in `run.ts` (the legitimate role of a command handler) |

### Target module layout

```
src/core/orchestration/
  run-phase.ts        live, unchanged: the mandatory phase boundary
  pipeline.ts         NEW: the spine (run.ts:918-1231), sequence + gates only
  handoff.ts          NEW: typed inter-phase store, replaces ctx mutation for the §4 subset
  phases/
    setup.ts          runSetupPhase
    doc-bootstrap.ts  runDocBootstrap + the doc-conflict-bootstrap call
    rag.ts            runRagPhase
    internal-docs.ts  runDocUpdate + reindex + the doc-conflict-update call
    refinement.ts     the 1093-1205 closure + runRefinementPhase wiring
    report.ts         runReportPhase
    review.ts         runReviewPhase (hot path, extracted last)
```

After the final PR, `run.ts` keeps only: CLI parse, `RunContext`
construction, lock / SIGINT / abort lifecycle, renderer + `PipelineState`
construction, and a single `await runPipeline(ctx)` call.

## 4. The handoff: signal vs noise

`ctx` is mutated everywhere, but only the following is a genuine cross-phase
handoff and therefore belongs in the typed store (`handoff.ts`):

- **Return-value handoff:** `setup` (the `SetupResult`: `tasks`, `triageMap`,
  `usageGraph`, `depMeta`, `projectTree`, `docsTree`, `internalDocsTree`,
  `internalDocsDir`, `files`) and `ragContext` (the `RagContext`:
  `vectorStore`, resolved RAG mode).
- **`ctx`-mutation handoff:** `arbitratedFragments`
  ([1073](../../src/commands/run.ts#L1073)), `totalFindings`
  ([1177](../../src/commands/run.ts#L1177)), `filesReviewed`, `totalFiles`
  ([2533](../../src/commands/run.ts#L2533)), `allTasks` / `triageMap`
  ([1712-1713](../../src/commands/run.ts#L1712)), `docPipelineResult`
  ([2009](../../src/commands/run.ts#L2009)/[2072](../../src/commands/run.ts#L2072)),
  `docReportResult`
  ([2912](../../src/commands/run.ts#L2912)/[2934](../../src/commands/run.ts#L2934)),
  `isFirstRun` ([938](../../src/commands/run.ts#L938)), `resolvedModels`
  ([2259](../../src/commands/run.ts#L2259)).

Everything else mutated on `ctx` (`lockPath`, `renderer`, `pipelineState`,
`interrupted`, `activeAborts`, `fatalError`, `runDir`, `runLog`, `gitInfo`,
`profile`, `quickWin`, `axesFilter`, `dryRun`, config-derived fields) is
runtime, UI, or lifecycle. It is **not** handoff and must **not** enter the
typed store. It stays on the object `run.ts` owns.

## 5. The blocking prerequisite: the safety net does not exist

Verified: `src/commands/run.test.ts` asserts only `recordLlmCost`
three-bucket cost arithmetic and a glob. There is **no end-to-end orchestration
test, no deterministic transport double, no record/replay, no fake router**.
Doc 10 §7's last row ("Regression suite makes drift unmergeable: hollow") is
accurate, and it is the single most load-bearing fact in this plan.

Consequence for the zero-debt constraint: **no phase can be extracted safely
until the net exists.** Building the net is therefore not preparatory work, it
is PR 1, co-equal with deleting the dead code. ALS already exists at the spine
(`runWithContext({ runId }, ...)`, [run.ts:918](../../src/commands/run.ts#L918)),
so the net widens an existing scope rather than introducing one.

## 6. PR sequence

Every PR below is independently revertible with a single `git revert`, carries
no data or schema migration, and ships only if its acceptance gate is green.

### PR 1: Net plus dead-code removal (no extraction)

`run.ts` logic is **not touched**. Goal: make doc 10's scorecard tell the
truth and give every later PR a real regression gate.

1. **Deterministic transport double.**
   `src/core/transports/recording-transport.ts` plus an
   `ANATOLY_TRANSPORT=record|replay` mode. `record` captures real
   `query()` / `agenticQuery()` once against a fixed fixture repo; `replay`
   serves typed canned responses thereafter. This is the critical-path item:
   without it no orchestration test can exist.
2. **Orchestration golden test.** Drive a full `anatoly run` against a tiny
   fixture repo under `replay`. Assert an order-normalized **projection**, not
   raw bytes: the exact `CANONICAL_PHASES` sequence actually executed, each
   gate decision, the presence of every `phaseDurations` key, and the handoff
   values (`filesReviewed`, `totalFindings`, produced artefact set). Deleting or
   reordering any `runPhase(...)` call in the spine must make this test fail.
3. **Delete the dead scaffolding.** Remove `src/core/orchestration/executor.ts`,
   `exchange.ts`, the entire `registry/` tree (33 files), and the hollow tests
   (`coverage.test.ts`, `artefact-separation.test.ts`, `cost-integrity.test.ts`,
   `executor.test.ts`, `exchange.test.ts`, `plan-fidelity.test.ts`, both
   `registry.test.ts`). **Keep** `run-phase.ts` and `run-phase.test.ts` (live,
   honest). For `types.ts`: delete if only the removed modules reference it,
   otherwise relocate the live subset.
   - Guard: before deleting each hollow test, diff it. Any assertion that
     touches live code (for example a `recordLlmCost` reconciliation that is not
     already covered by `run.test.ts`) is preserved or relocated first, then the
     rest is deleted. No live coverage is lost in a deletion.
4. **Update doc 10** in the same PR (see §7).

Acceptance gate: golden test green and its projection captured as the baseline;
full unit suite green; typecheck and lint clean;
`grep -rn "orchestration/executor\|orchestration/exchange\|orchestration/registry" src --include=*.ts`
returns zero matches; `anatoly run` on the fixture is behavior-identical to
pre-PR.

### PR 2 to PR 7: Extract one phase per PR (move-only, golden-gated)

One `runXPhase` per PR, moved into `orchestration/phases/X.ts` with **zero
logic change**. The spine still calls it. Order chosen by ascending coupling so
the riskiest extraction happens last against the most-exercised net:

| PR | Phase extracted | Why this order |
|----|-----------------|----------------|
| 2 | `report` | leaf, returns `void`, no handoff out |
| 3 | `setup` | introduces `handoff.ts`, typed for `SetupResult` |
| 4 | `rag` | adds `ragContext` to the typed handoff |
| 5 | doc phases (`bootstrap` + `internal-docs` + the two conflict calls) | doc handoff (`docPipelineResult`, `arbitratedFragments`) |
| 6 | `refinement` | the inline closure becomes a real phase module |
| 7 | `review` | hot path, most `ctx`-coupled, extracted last |

Per-PR acceptance gate: the golden projection is **byte-identical** to PR 1's
baseline; the diff is move-only with no logic delta (reviewer-attested and
golden-enforced); typecheck, lint, full suite green. The typed handoff surface
grows only as far as the phase being moved forces it; no speculative typing.

### PR 8: Extract the spine, retire the god-object handoff

Move [run.ts:918-1231](../../src/commands/run.ts#L918) into
`orchestration/pipeline.ts`. `run.ts` becomes a thin handler: build `ctx`,
acquire lock, install SIGINT, construct renderer, then `await runPipeline(ctx)`.
Replace the §4 inter-phase `ctx` mutations with the typed `handoff.ts` object
passed explicitly through the pipeline. Runtime / UI / lifecycle fields stay on
`ctx`.

Acceptance gate: golden projection unchanged; `src/commands/run.ts` contains
zero `async function run*Phase`; the spine lives in
`orchestration/pipeline.ts`; the §4 handoff is a typed object, not `ctx` field
mutation; full suite, typecheck, lint green.

## 7. Effect on the canonical contract (doc 10)

Strategy B **changes the target contract**, and that change is recorded, not
hidden. Each PR updates doc 10 in lockstep.

- **§1 invariants 2 and 4** (single agent gateway with minted `callId`; central
  exchange as the data stream) are **recast**. Strategy B does not wire the
  gateway or the exchange; it deletes them. After PR 1 these stop being
  "unbuilt backlog carried as dead code" and become an **explicit non-goal**: a
  future, separately-justified effort if a need ever materializes. The honest
  position becomes: the de-facto seam (the four transports plus the
  ALS-scoped D.4 sink) is the accepted seam. Nothing pretends a gateway exists.
- **§7 scorecard.** The ❌ rows "Single agent gateway", "Composer registry
  dispatched at runtime", "DAG executor invoked", "Central exchange" change from
  ❌ *not built* to **REMOVED (Strategy B, PR 1)**, with the PR reference. They
  are no longer contract clauses.
- **§7 / §8 D.2 naming and `callId`.** The conversation-dump naming correction
  ([spec-conversation-dump-naming-correction.md](../../_bmad-output/planning-artifacts/spec-conversation-dump-naming-correction.md))
  depends on a gateway that Strategy B does not build. It is **explicitly
  deferred** and tracked separately, not retained as dead code.
- **§8 invariants 4 and 5** (synthetic call driven through the gateway;
  registry observed-run assertion) are **out of scope** under Strategy B. They
  are replaced by the new, actually-testable invariant the golden enforces:
  the orchestration golden, under `replay`, asserts the exact canonical phase
  sequence, gate decisions, `phaseDurations` keys, and handoff values; any
  reorder, skipped gate, or handoff regression fails it.

## 8. Non-goals (to honor zero debt)

Zero debt means no aspirational dead code and no behavior change smuggled into a
refactor. Explicitly **out of scope**:

- Building the gateway, registry dispatch, or exchange.
- Any change to pipeline behavior: phase order, gates, models, costs, outputs,
  or artefact layout. Every PR is behavior-preserving by construction and proven
  so by the golden.
- A wholesale `RunContext` rewrite. Only the §4 inter-phase subset is typed and
  relocated; runtime / UI / lifecycle fields are untouched.
- The D.2 conversation-dump naming correction (depends on a gateway not built
  here; tracked separately).

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Replay infidelity: nondeterminism (the `tier3-shard-${Date.now()}` prefix at [run.ts:1121](../../src/commands/run.ts#L1121), `Promise.allSettled` ordering, worker-pool concurrency) makes the golden flaky | The golden freezes the clock, fixes the seed, forces a single worker, and asserts an **order-normalized projection** (sorted executed-phase list, `phaseDurations` key presence not values, findings count, artefact set), never raw bytes |
| Hidden `ctx` coupling: an extracted phase reads a `ctx` field cross-phase that is not in the §4 subset | PR 3 introduces `handoff.ts` with a typed surface; a lint rule plus the golden catch any new cross-phase `ctx` read; every extraction PR is gated on it |
| Deleting a test that incidentally covered live code | §6 PR 1 step 3 guard: diff each hollow test before deletion; preserve or relocate any assertion touching live code first |
| A phase extraction silently changes behavior | Move-only constraint, reviewer-attested no-logic-delta, and a byte-identical golden projection against the PR 1 baseline; any drift fails CI |

## 10. Plan acceptance invariants

Testable assertions that say whether the remediation actually landed. They
mirror the doc 10 §8 style: written so they fail today and pass only when the
plan holds.

1. After PR 1:
   `grep -rn "orchestration/executor\|orchestration/exchange\|orchestration/registry" src --include=*.ts`
   returns zero matches, and the full suite is green.
2. After PR 1: the orchestration golden under `ANATOLY_TRANSPORT=replay`
   produces a stable asserted projection; deleting or reordering any
   `runPhase(...)` call in the spine makes it fail.
3. For every extraction PR (2 to 8): the golden projection is byte-identical to
   the PR 1 baseline and the diff carries no logic delta.
4. After PR 8: `src/commands/run.ts` contains zero `async function run*Phase`,
   the spine lives in `src/core/orchestration/pipeline.ts`, and the §4
   inter-phase handoff is a typed object rather than `ctx` field mutation.
5. After PR 8: doc 10 §7 scorecard and §8 invariants are updated so no row
   claims an unbuilt gateway, registry, or exchange as backlog; removed pillars
   are marked REMOVED with the PR reference.

## See also

- [10-Orchestration-Runtime.md](./10-Orchestration-Runtime.md): the contract
  this plan remediates. Read its §7 scorecard and §8 invariants alongside this
  document's §7 and §10.
- [08-Transport-Architecture.md](./08-Transport-Architecture.md): the transport
  layer the deterministic double in PR 1 wraps.
- [epic-56-unified-orchestration-runtime.md](../../_bmad-output/planning-artifacts/epic-56-unified-orchestration-runtime.md):
  the original four-pillar intent. Strategy B keeps Pillar A (the phase
  boundary), accepts Pillar D.4 as-is, and removes Pillars B and C.
