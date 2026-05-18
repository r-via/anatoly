# Unit Harness and Orchestration Policy (execution contract)

> Status: this document is the **execution contract** for the next gap on the
> orchestrator. Doc 11 extracted the spine and the phases (PRs 1 to 8,
> complete, merged to `main`). It left three things that doc 10 §4 names: the
> inter-phase data path is still three uncoordinated channels; there is no
> single contract that both phases and agents implement, so every new
> execution unit re-wires its own cost, event, transcript and log plumbing by
> hand; and the orchestration policy (which phase runs, when, under what
> condition) is imperative if/else dispersed through the spine. This document
> decides how a single unit harness is introduced **and** how the orchestration
> policy is centralized into one named-gate table that a still-procedural spine
> reads, so future phases and agents plug into one structure and the rules
> live in one readable place. It is binding: once a PR below lands, the
> matching line in doc 10 is updated in the same PR, never after. It is the
> structural sibling of
> [11-Orchestration-Remediation-Plan.md](./11-Orchestration-Remediation-Plan.md)
> and [13-Core-Module-Remediation-Plan.md](./13-Core-Module-Remediation-Plan.md)
> and follows their proven shape.
>
> Constraint set by the owner, verbatim in intent: *no debt is acceptable on
> the orchestrator; it must work correctly.* Every step here is
> behavior-preserving by construction and bench-gated, or it does not ship.
>
> **Closure (the whole contract is now resolved).** Shipped,
> behavior-preserving, typecheck + suites + spine/handoff goldens green:
> **PR 0, 1, 2-net, 2a, 2b, 3a, 3b, 3c, 4a, 4b** (agent / harness / cost
> track) and **PR 5** (orchestration policy table, §6-faithful: `gates.ts`
> predicate table read by a still-procedural spine). **Declined, reasoned
> non-goals** (§8, not debt): **PR 4c** (literal `runPhase`/`runUnit` merge
> is aesthetic; accounting-as-projection is YAGNI, its motivation met by
> PR 2b/4a) and **PR 6** (frozen-view/scoped-writer machinery is predicated
> on the declined RunSink; the regression class is single-writer-by-
> convention, has zero evidence, and is already foreclosed by PR 1 + the
> goldens — §8's own skip clause). §5 and §9 are reconciled to the realized
> shape so this contract has no internal contradiction. **Open:** the
> branch must be re-benched at the PR-5 tip (`6962c51`) before merging the
> series to private `main` (the v29 bench, global_f1 0.715, validated
> `3b27b7b`, pre-PR-5). No further doc-14 work remains.

## 1. The decision

The owner's target, restated in the owner's terms: *one convention that gives
phases and agents a single central point of interaction, a harness and a
structure that future implementations are forced through, so there is no code
duplication and no third-party process doing the same job a different way;
and a unified pipeline orchestrator whose rules are centralized.*

This is an extension-point problem plus a policy-location problem, not a
telemetry problem. Two questions:

1. Is there exactly one sanctioned way to add a phase or an agent, such that
   it structurally cannot re-implement the wiring differently?
2. Do the orchestration rules (sequence, gates, conditions) live in one
   readable place, without an unproven generic engine interpreting them?

Three paths were on the table for the harness.

- **Form-first (a uniform `PhaseEnvelope` big-bang).** Rejected: phase grain
  only, leaves the agent grain (where the duplication lives, §2) untouched,
  lands the guarantee last in one wide diff.
- **A declarative orchestration engine** (registry / executor interpreting a
  phase graph). Rejected, and the rejection is not new: this is the Epic 56
  scaffolding doc 11 §1 already deleted as a ghost migration (zero runtime
  callers). A generic engine trades a known-correct procedural spine for an
  unproven mechanism. The zero-debt constraint forbids it.
- **Unify by extending the honest seeds, incremental, two grains, plus a
  named-gate policy table read by a spine that stays procedural.** Chosen.

Rationale, in one sentence, echoing doc 11 §1: a contract is enforced by the
single code path everything is obliged to take, and rules are centralized by
being named data in one table rather than by a cathedral that interprets them.

## 2. Diagnosis (grounded)

Verified at HEAD `ab1034e`, branch `orchestration-sink-convention` (off
`main`, post doc-11 PR 8).

| Fact | Measure |
|---|---|
| Agent SPI today | `AxisEvaluator` ([contract.ts:132](../../src/core/evaluation/contract.ts#L132)): `id`, `defaultModel`, `evaluate(ctx, abort) -> AxisResult`. Implemented by the 7 axes + `file-evaluator` + `evaluator`. **Axis-only** |
| Agents outside that SPI | doc generation (`doc-llm-executor.ts`: `ExecuteDocPromptsParams -> DocLlmResult`, plus a second `DocCoherence*` shape) and refinement (`refinement/phase.ts`: `RefinementContext -> RefinementResult`). **Three-plus divergent agent contracts** |
| Shared agent harness today | `runSingleTurnQuery` ([evaluator.ts:222](../../src/core/evaluation/evaluator.ts#L222)) "eliminate[s] duplicated SDK boilerplate", but only for single-turn axes |
| Cost fold-up | hand-rolled at **5 phase sites**: [rag.ts:300](../../src/core/orchestration/phases/rag.ts#L300), [review.ts:378](../../src/core/orchestration/phases/review.ts#L378), [doc.ts:169](../../src/core/orchestration/phases/doc.ts#L169), [doc.ts:254](../../src/core/orchestration/phases/doc.ts#L254), [refinement.ts:132](../../src/core/orchestration/phases/refinement.ts#L132) |
| Orchestration policy | imperative if/else inline at [pipeline.ts:144-292](../../src/core/orchestration/pipeline.ts#L144): doc-mode `off`/`lite`/`full` branching, `hasEvaluableFiles` triage gate, `deliberation && filesReviewed > 0` gate, doc-conflict sub-phase gates, and the `if (ctx.interrupted) return` summary block duplicated 3 times with bespoke strings. Only the *sequence* is centralized (`CANONICAL_PHASES`, [run-phase.ts:17](../../src/core/orchestration/run-phase.ts#L17)); the *gates* are not |
| Event emission | not in any unit contract; phases narrate free-string events at 2+ sites ([review.ts:208](../../src/core/orchestration/phases/review.ts#L208), [254](../../src/core/orchestration/phases/review.ts#L254)); a double-emit 200% counter comment already in tree ([review.ts:373](../../src/core/orchestration/phases/review.ts#L373)) |
| Inter-phase data channels | 3: typed `Handoff` (~10 fields), `RunContext` god object (40+ mutation sites), positional return values |
| Convention enforced | only `phase_start` / `phase_end` at the phase boundary ([run-phase.ts:75](../../src/core/orchestration/run-phase.ts#L75)) |

In one sentence: the unit contract exists but axis-only, the shared harness
exists but single-turn-only, and the orchestration rules are imperative and
dispersed, so every new agent and phase re-implements the wiring and the
policy is unreadable as a whole.

## 3. The unit model (lock this before any code)

One contract, two specializations, nested grain. A phase contains agents; both
are units; the harness wraps both.

```
ExecutionUnit (the SPI, the only sanctioned entry)
  ├─ Phase  : a unit whose body invokes agent-units in sequence/parallel
  └─ Agent  : a unit whose body is one bounded LLM interaction
               (axis evaluator, doc generator, refinement pass)
```

The contract is deliberately narrow:

```
interface ExecutionUnit<I, O> {
  readonly name: string;          // registry key, event/cost attribution
  run(input: I, h: HarnessCtx): Promise<O>;
}
```

`HarnessCtx` is the single central point of interaction. The implementer
**never** calls `recordLlmCost`, **never** pushes an event, **never** writes a
transcript, **never** opens a log scope: those mechanisms are not on the unit
surface. `AxisEvaluator` is the existing proven shape at the agent grain; the
work generalizes it so doc and refinement satisfy the same interface.
`HarnessCtx.abortController` is **optional** (corrected at PR 3c): the axes
and refinement expose an abort handle at their boundary, the doc generation /
coherence agents do not, and fabricating one the agent never reads would
violate the PR-3b no-synthetic-handle principle.

## 4. The single harness

`runUnit`, formed by merging the two chokepoints that already exist:
`runPhase` (phase grain) and `runSingleTurnQuery` + the Story 56.11 ALS scope
(agent grain). It is the only place these happen, for every unit at both
grains:

| Harness duty | Seed it is built from |
|---|---|
| open log + ALS context (`runId`, `phase`, `composer`, `primitive`) | `runPhase` `runWithContext`, `runSingleTurnQuery` scope |
| emit typed convention events, enforce the unit declared its event set | `runPhase` effects a-h, generalized |
| fold the unit cost into the sink | replaces the 5 hand-rolled `recordLlmCost` sites |
| capture transcript / conversation | `AxisResult.transcript`, `conversationDir`, lifted off call sites |
| latch run-fatal, honor interrupt/abort | `run-control.requestFatalStop`, `runPhase` fatal rethrow |

Placement (corrected at PR 3a, supersedes the PR-2a note): `runUnit` and the
`ExecutionUnit` / `HarnessCtx` SPI live in their own dependency-free bounded
context **`core/harness/`** (`contract.ts` + `runner.ts` + `index.ts`
barrel). PR 2a had placed them in `core/evaluation` to dodge the
orchestration<->evaluation cycle; that was locally correct but globally
insufficient. `documentation` is also an agent host, and `evaluation` has a
runtime edge into it (`file-evaluator -> documentation`), so a
documentation agent could not reach an evaluation-hosted harness without an
`evaluation -> documentation -> evaluation` cycle. A "single harness every
agent flows through" is only cycle-free if it depends on nothing in `core/`.
`core/harness/` does (its only named type is the global `AbortController`),
so `evaluation`, `documentation`, `refinement` and (PR 4) `orchestration`
all import it via its barrel without any cycle. This is the §1 "one harness"
realized as a shared kernel, and it de-risks the PR 4 phase-grain
unification (orchestration -> harness, not orchestration -> evaluation).
doc 12's context inventory gains `harness/` (shared kernel, fan-in many,
fan-out zero).

## 5. The frontier contract

The primary trap, identical in spirit to doc 11 §2's god-object warning, is
conflating three categories of state in one mutable bag. This table is binding.

| Category | Definition | Home | Direction |
|---|---|---|---|
| **Lifecycle** | `fatalError`, `interrupted`, `activeAborts`, lock path, renderer / `pipelineState` handles | `RunContext`, forever | not inter-unit, never enters the sink |
| **Sink** | events, llm costs, conversations, structured logs | harness-owned, single chokepoint per grain (see realized note) | fed by unit N, read-only to unit N+1 |
| **Handoff** | the product a unit makes that a later unit consumes (`tasks`, `triageMap`, `ragContext`, `docPipelineResult`, counts) | typed `Handoff` | directional, never a shared mutable counter |

Two anti-dogma rulings, explicit so they are not relitigated:

1. **Lifecycle stays on `ctx`.** Forcing it into the sink for a one-object
   aesthetic is dogma, not value.
2. **Run accounting is not a scattered fourth bucket.** Original intent: make
   it a derive-on-read sink projection. Realized instead (PR 2b/4a, and
   reconciled here): the *scattered hand-synced reconciliation burden* this
   ruling targeted is gone — every cost write is now a single harness-owned
   [cost.ts](../../src/core/orchestration/cost.ts) function and
   `recordLlmCost` is the one reconciliation point. `totalCostUsd` /
   `providerStats` / `phaseStats` / `axisStats` remain an eager rollup on
   `ctx` (the §5-sanctioned home for run accounting), written **only** via
   that harness-owned module, never inline in a phase/agent body, and locked
   byte-identical by `cost.test.ts`. The literal derive-on-read projection is
   the declined §8 PR 4c (YAGNI: zero user-visible change, ~44 consumers).

Realized note (post-closure): the single `RunSink` object was **not** built
(declined §8 PR 4c). What is realized is harness-owned centralization with
one chokepoint per grain — events via the typed vocabulary (PR 1),
agent-grain via `runUnit` (PR 2a/3), phase-grain cost via the harness-owned
`cost.ts` (PR 2b/4a). The "one sink, reached only via `HarnessCtx`" row above
is the original aspiration, not the shipped shape; it is recorded here so the
frontier table is not read as delivered-as-written.

## 6. The orchestration policy table (named gates, procedural spine)

This is the "centralized rules" half. Today the rules of *what runs when*
are imperative branches scattered across [pipeline.ts:144-292](../../src/core/orchestration/pipeline.ts#L144).
They move into **one table**, one entry per phase, that a still-procedural
spine reads. The sequence is already centralized in `CANONICAL_PHASES`; this
adds the gate and the skip vocabulary beside it.

```
interface PhaseGate {
  phase: PhaseName;
  decide(ctx, handoff): { run: true } | { run: false; reason: string };
}
```

The skip `reason` strings are not invented: they are today's literals
(`'off'`, `'lite (per-file retrieval)'`, `'skipped, no evaluable files'`,
`'skipped, deliberation disabled'`) lifted into the table and reused verbatim
for `pipelineState.completeTask(phase, reason)`, so the display is unchanged.
The duplicated `if (ctx.interrupted) return <bespoke summary>` block collapses
into one interrupt rule the spine applies once per iteration.

**The deliberate non-goal, the line against Epic 56.** The spine stays a
concrete procedural function. It does not interpret a declarative graph. The
table is *data the procedural loop reads* (ask gate, run or record-skip,
next), not *a program a generic executor runs*. Centralized rules, no
cathedral. This is the boundary doc 11 §1 drew and this section keeps.

## 7. Why this forecloses duplication structurally

The SPI is the only entry, the harness owns every cross-cutting mechanism, and
every gate is one named predicate in one table. A new phase or agent is a
class implementing `ExecutionUnit` plus one `PhaseGate` row. It physically
cannot record cost differently, emit an off-convention event, skip the sink,
hand-roll a transcript, or hide a gate in inline branching, because none of
those are reachable from its surface. "A third-party process that does the
same thing differently" stops being a review norm and becomes structurally
impossible.

## 8. PR sequence (ascending risk, per-PR bench gate)

Net: bench F1 baseline `0.6729` (slot-engine v28, the figure that cleared the
doc-11 merge). A PR boundary is green only if F1 is within run-to-run noise of
that baseline and the new convention test passes. Each PR reverts with one
`git revert` and ends green.

- **PR 0** This ADR, plus the doc 10 §4 cross-link. No code.
- **PR 1** Typed event union, registry, `emit()` helper, completeness test, at
  the phase grain inside `runPhase`. Free-string `event:` sites replaced
  verbatim. Behavior-preserving. Lowest risk first. Gate: bench F1 unchanged,
  completeness test green.
  Correction (grounded at `b9b7a55`, supersedes the original single "PR 2"):
  the original PR 2 was mis-specified on two points found at grounding. (i)
  Its stated gate "golden ledger byte-identical" does not cover the change:
  the 5 `recordLlmCost` sites feed the in-memory rollup
  ([cost.ts](../../src/core/orchestration/cost.ts)), not the on-disk ndjson
  ledger (written independently by the transport layer's `recordLlmCall`,
  the only thing cost-integrity.test.ts covers). No automated net existed for
  the rollup. (ii) Only 1 of the 5 sites
  ([review.ts:378](../../src/core/orchestration/phases/review.ts#L378)) is
  agent-grain (per-axis loop over `result.axisTiming`); the other 4
  (rag.ts:300, doc.ts:169, doc.ts:254, refinement.ts:132) are phase-grain
  reconciliations of an already-aggregated sub-engine cost, so they cannot
  "become harness calls by generalizing `runSingleTurnQuery`": they belong to
  the phase grain (PR 4), not the agent grain. PR 2 is therefore split:
- **PR 2-net** Build the missing net first (doc-11 pattern: a net that does
  not exist is a blocking prerequisite). `cost.test.ts`: pure synthetic
  entries fed into `recordLlmCost`, locking the exact bucket arithmetic
  (`totalCostUsd` / `providerStats` / `phaseStats` / `axisStats`), including
  the review.ts per-axis loop shape PR 2b will move. Zero LLM, milliseconds.
  No behavior change. Gate: the new test green; bench F1 unchanged.
- **PR 2a** `ExecutionUnit` + `runUnit` at the **agent grain** wrapping
  `runSingleTurnQuery`; the single-turn axes flow through it (wired, not
  unwired scaffold: §1 forbids the Epic 56 ghost). Behavior-preserving by
  pass-through. Gate: bench F1, axis + file-evaluator tests + goldens green.
- **PR 2b** Correction (grounded at `c5e03cf`): the review.ts:378 loop is
  **per-axis** (`result.axisTiming` is one entry per axis; file-evaluator
  already sums each axis's internal single-turn queries, e.g. `correction`'s
  two passes). `runUnit` (PR 2a) is the **single-turn-query** grain. Folding
  cost into `runUnit` would record multi-query axes more than once and
  diverge the rollup (not byte-identical; `cost.test.ts` would catch it).
  Also the per-axis `provider` is computed in file-evaluator, outside the
  agent. So PR 2b is not a `runUnit` fold. It relocates the review.ts:378
  loop **verbatim** into a harness-owned function
  (`orchestration/cost.ts` `recordAgentCosts`), called by the review phase
  with `result.axisTiming`. Grain unchanged (per-axis), byte-identical by
  construction; the review phase body no longer contains a `recordLlmCost`
  loop. The true agent-grain capture (harness wrapping
  `AxisEvaluator.evaluate`, provider attribution moved off file-evaluator) is
  deferred to PR 3/4 (when the §3-correct agent grain and the sink land).
  `recordAgentCosts` lives in `orchestration/cost.ts`, not beside `runUnit`
  in `evaluation/`, because it needs `RunContext`; `evaluation` cannot import
  it without the cycle (same constraint as §4). Gate: `cost.test.ts` proves
  `recordAgentCosts` is byte-identical to the inline loop; bench F1; the
  ndjson "golden ledger" is untouched by construction (these sites never
  wrote it).
- **PR 3** doc and refinement agents under the same `ExecutionUnit` SPI. They
  stop being three bespoke wirings. Split at grounding (a hard cross-context
  cycle, see §4): **PR 3a** relocated the harness to its own zero-dependency
  `core/harness/` context (the cycle-free home; supersedes the PR-2a
  placement). **PR 3b** wraps `runRefinementPhase` (in
  `core/evaluation/refinement`) as an `ExecutionUnit` through `runUnit`,
  PR-2a pattern (public name/signature kept, body verbatim renamed
  `runRefinementPhaseImpl`, byte-equivalent; `RefinementContext` already
  carries `abortController` so `HarnessCtx` is exact). **PR 3c** wraps
  `executeDocPrompts` / `runDocCoherenceReview` (in `core/documentation`, now
  cycle-free via `core/harness/`) likewise; `executeDocPrompts` has no abort
  boundary, which is why PR 3c made `HarnessCtx.abortController` optional
  (no synthetic handle). None of these use
  `runSingleTurnQuery` (different LLM paths), so they did not flow through
  `runUnit` before; PR 3 makes them conform to the one SPI. Gate per
  sub-PR: bench F1, typecheck + suites + goldens green.
- **PR 4** As written this bundled five semi-independent changes; split by
  ascending risk (the §8 discipline), the same way PR 2/3 were:
  - **PR 4a** Relocate the 4 phase-grain `recordLlmCost` sites
    (rag.ts:301, doc.ts:169, doc.ts:254, refinement.ts:132) **verbatim**
    into named harness-owned functions in `orchestration/cost.ts`
    (`recordRagCost`, `recordDocGenerationCost`, `recordDocCoherenceCost`,
    `recordRefinementCost`): the exact entry the phase built inline, with
    `provider`/`phase` hardcoded verbatim. Phase bodies no longer contain
    inline `recordLlmCost`. Byte-identical, fully independent of
    runUnit/sink/handoff (the proven PR-2b recipe). Gate: `cost.test.ts`
    proves each helper == its inline call; bench F1; goldens.
  - **PR 4b** (done, grounded at `6a8eca4`) Grounding found the two parts
    are not equivalent: `handoff.triageMap` is the identical ref to
    `setup.triageMap`, and the other 5 fan-out args are the same setup refs
    (so threading them via `Handoff` is **byte-identical**); but
    `handoff.allTasks` is the **scan-filtered** set
    (setup.ts:235 `rawTasks.filter(scannedFileSet)`) whereas review.ts:137
    `loadTasks(...)` is **unfiltered raw** — replacing one with the other is
    a behaviour change, not preservation. Owner decision: **fan-out only,
    keep `loadTasks`**. `Handoff` gained 6 optional fields
    (`usageGraph`, `depMeta`, `projectTree`, `docsTree`, `internalDocsTree`,
    `internalDocsDir`), populated in setup with the exact returned refs;
    `runReviewPhase` collapsed to `(ctx, handoff, ragContext)` and
    destructures them from `handoff` (body identifiers unchanged);
    pipeline.ts passes 3 args. `review.ts:137` `loadTasks` left untouched;
    the tasks-source swap is split out (not done: it needs bench F1, the
    goldens cannot see the filtered/unfiltered difference). Byte-identical
    by construction; gated by the spine + handoff goldens (the handoff
    golden asserts the setup -> review -> report handoff).
  - **PR 4c — DECLINED (deliberate, reasoned non-goal; grounded at
    `dd9fd56`).** Not debt: an explicit scope boundary, which is what this
    binding contract exists to record. Two pieces, both rejected:
    1. *Literal `runPhase` -> `runUnit` merge.* `runPhase` is already the
       single, non-divergent phase chokepoint (doc 14 §1 called it "the only
       honest piece"); there is no phase-grain divergence to remove. Its 8
       effects are `RunPhaseContext`/orchestration-bound while `runUnit` is
       the zero-dep `core/harness` kernel, so a literal merge re-introduces
       exactly the orchestration -> harness coupling PR 3a removed. "One
       harness" is met **logically**: one way to run an agent (`runUnit`),
       one to run a phase (`runPhase`), both uniform chokepoints in
       cycle-safe contexts. Forcing one function is aesthetic, against the
       §1 "simple, no speculative surface" stance.
    2. *Accounting-as-projection (the §5 ruling-2 end-state).* Its stated
       motivation was removing the scattered hand-synced reconciliation
       burden. PR 2b/4a **already achieved that**: every cost write is now a
       single harness-owned `orchestration/cost.ts` function and
       `recordLlmCost` is the one reconciliation point. The residual
       derive-on-read projection is a behaviour-relevant rewrite across ~44
       eager-rollup consumers (reporter, calibration, report/run-metrics)
       for **zero user-visible change** (identical numbers), weakly netted.
       YAGNI and dogma-adjacent; declined. §5 is reconciled accordingly.
    **The agent / harness / cost track is complete at PR 4b.** (PR 5 below
    shipped §6-faithful; PR 6 below is declined; see the §8 entries and the
    status-block closure.)
- **PR 5 (done, §6-faithful; the §8 "loop over `CANONICAL_PHASES`" wording
  is superseded — see below).** Grounding showed the gates are entangled
  with phase bodies, `doc-conflict-*` sub-phases, `writeScaffoldStatus`,
  `reindexDocsAfterUpdate`, `completeTask` UI calls and `handoff` mutation:
  they are **not** 1:1 with `CANONICAL_PHASES` (the doc-mode branch is 3-way
  off/lite/full). A literal "procedural loop over `CANONICAL_PHASES`
  dispatching the table" would be a deep behavior-relevant redesign drifting
  toward the generic executor §1/§6 reject. Owner decision: **§6-faithful**.
  Realized: `src/core/orchestration/gates.ts` holds the run/skip
  **predicates** + the **verbatim** skip-reason strings for the three gated
  phases (`bootstrapDocGate`, `internalDocsGate`, `refinementGate`,
  `GateDecision = {run, reason?}`); the spine consults the gate then runs
  the **inline, verbatim** phase body / sub-phases / effects exactly as
  before (the table is data the procedural spine reads, doc 14 §6, not a
  program). The triplicated `if (ctx.interrupted){…summary…return}` tail
  collapses to `emitInterruptSummary()` (the distinct pre-review
  `0/${setup.files}` variant is intentionally left). **Behaviorally
  byte-identical by construction**: same conditions, same reason strings,
  same order, same `!ctx.interrupted` guards, same bodies. §8's
  "`CANONICAL_PHASES` loop" is hereby reconciled to §6's predicate-table
  (the two diverged; §6 is binding, §1's anti-cathedral stance wins). Gate:
  typecheck + suites + spine/handoff goldens green; **a re-bench at the
  PR-5 tip is required before merge** (PR 5 touches spine control flow; the
  v29 bench validated `3b27b7b`, pre-PR-5).
- **PR 6 — DECLINED (reasoned non-goal; grounded at `6962c51`).** Its core
  mechanism, *"a frozen view of the prior **sink**"*, is predicated on the
  single `RunSink` that PR 4c deliberately declined: there is no sink to
  view; `handoff` is a typed struct, **single-writer-by-phase by
  convention** (setup writes the setup fields, review the review counts,
  refinement nets `totalFindings` down afterward by intent, doc/report their
  result fields). The cross-phase corruption regression class it guards has
  **zero evidence** and is already foreclosed by PR 1's typed events +
  PR 2-net's cost lock + the spine/handoff goldens, which is exactly the
  skip condition §8 stated for PR 6. The `handoff.x++` it targets is
  intra-review-phase across the **async** worker pool on single-threaded
  Node (no parallel threads, no data race) and is behaviourally
  golden-locked (handoff golden + the v29 bench: 10 concurrent files,
  correct counts). Per-phase frozen-view + scoped-writer proxies would add
  runtime cost, churn (rewire every `handoff` access) and a speculative
  generic capability surface: precisely the §1 "boring, simple, no
  speculative surface, scale when needed" stance, the same reasoning that
  declined PR 4c. Not debt: an explicit reasoned boundary.

## 9. Acceptance invariants (testable, not aspirational)

1. No phase or agent **body** contains an inline `recordLlmCost`. Realized
   (PR 2b/3/4a): phase-grain cost is owned by the harness `orchestration/cost.ts`
   functions (`recordAgentCosts`, `recordRagCost`, `recordDocGenerationCost`,
   `recordDocCoherenceCost`, `recordRefinementCost`); every agent flows
   through `runUnit`. The stronger "single sink reached only via `HarnessCtx`"
   form is the declined §8 PR 4c, not a pending item: this is the realized,
   honest invariant.
2. Every phase and every agent implements `ExecutionUnit` and is registered;
   doc and refinement satisfy the same interface as axes.
3. Every unit declares its event set; a unit exiting without emitting it fails
   CI.
4. Every phase's run/skip condition is one named `PhaseGate` row in one table;
   pipeline.ts contains no inline phase-gating if/else; the spine is a
   procedural loop over the table, not a graph interpreter.
5. Units touch only two mutable `ctx` surfaces: the §5 lifecycle fields, and
   the run-accounting rollup (`totalCostUsd` / `providerStats` /
   `phaseStats` / `axisStats`) — and the latter only through the
   harness-owned `cost.ts` module, never constructed inline in a phase/agent
   body. (Original wording said "lifecycle only"; reconciled here because
   accounting-as-projection was declined, §8 PR 4c, so the rollup stays its
   §5-sanctioned eager `ctx` home.)
6. The in-memory cost rollup (`totalCostUsd` / `providerStats` /
   `phaseStats` / `axisStats`) is locked by `cost.test.ts`; any cost-fold PR
   keeps it byte-identical against that synthetic net.
7. Bench F1 within run-to-run noise of `0.6729` at every PR boundary.

## 10. Why this is not doc 11 or doc 13 again

Doc 11 moved the spine and phases out of `run.ts` (location) and explicitly
left the sequence-and-gates concern relocated but still imperative (doc 11 §3).
Doc 13 repartitioned `src/core` (structure). Both are done and merged. This
document changes neither location nor partition: it introduces the one
contract and one harness that phases and agents are obliged to take, and
centralizes the orchestration rules into one named-gate table without the
generic engine doc 11 deleted. It is the last of the three to close the doc 10
§4 gap, and the only one whose payoff is a permanent extension point and a
readable policy, not a one-time cleanup.
