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

Placement (grounded at PR 2a): `runUnit` and the `ExecutionUnit` / `HarnessCtx`
SPI physically live in `core/evaluation` (`contract.ts` + `evaluator.ts`,
beside `runSingleTurnQuery`), not in `orchestration/`. The agents (axes)
import the harness, and `orchestration` already depends on `evaluation`;
putting the harness in `orchestration` would create an
`evaluation -> orchestration -> evaluation` import cycle. "One harness" is a
logical contract realized across the two layers: the agent grain lands here
at PR 2a, and the phase grain (`runPhase`) is unified onto the same `runUnit`
at PR 4. This is a forced layering call, not an alternative to the §1
decision.

## 5. The frontier contract

The primary trap, identical in spirit to doc 11 §2's god-object warning, is
conflating three categories of state in one mutable bag. This table is binding.

| Category | Definition | Home | Direction |
|---|---|---|---|
| **Lifecycle** | `fatalError`, `interrupted`, `activeAborts`, lock path, renderer / `pipelineState` handles | `RunContext`, forever | not inter-unit, never enters the sink |
| **Sink** | events, llm costs, conversations, structured logs | one sink, reached only via `HarnessCtx` | fed by unit N, read-only to unit N+1 |
| **Handoff** | the product a unit makes that a later unit consumes (`tasks`, `triageMap`, `ragContext`, `docPipelineResult`, counts) | typed `Handoff` | directional, never a shared mutable counter |

Two anti-dogma rulings, explicit so they are not relitigated:

1. **Lifecycle stays on `ctx`.** Forcing it into the sink for a one-object
   aesthetic is dogma, not value.
2. **Run accounting is a sink projection, not a fourth bucket.**
   `totalCostUsd` / `providerStats` / `axisStats` are views derived on read,
   not a hand-synced `ctx` accumulator (today's
   [cost.ts](../../src/core/orchestration/cost.ts) reconciliation burden).

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
- **PR 2b** Fold only the one agent-grain cost site (review.ts:378) into the
  harness. Gate: bench F1, `cost.test.ts` byte-identical rollup (PR 2-net is
  the proof; the ndjson "golden ledger" is untouched by construction since
  these sites never wrote it).
- **PR 3** doc and refinement agents under the same `ExecutionUnit` SPI. They
  stop being three bespoke shapes. Gate: bench F1.
- **PR 4** Unify the **phase grain** onto `runUnit`. Positional `SetupResult`
  fan-out into `runReviewPhase` dies; review stops re-loading tasks from disk
  ([review.ts:136](../../src/core/orchestration/phases/review.ts#L136)); one
  sink object threaded by the harness. The 4 phase-grain `recordLlmCost`
  sites (rag.ts:300, doc.ts:169, doc.ts:254, refinement.ts:132) fold into the
  phase-grain harness here, gated by `cost.test.ts`. Gate: bench F1,
  orchestration golden.
- **PR 5** Extract the orchestration policy: every inline gate at
  pipeline.ts:144-292 becomes a `PhaseGate` row in one table; the spine
  becomes a procedural loop over `CANONICAL_PHASES` reading the table; the
  triplicated interrupt-return block collapses to one rule. Pure relocation of
  predicates, behavior-preserving. Gate: bench F1, orchestration golden
  byte-identical.
- **PR 6 (optional)** Directional access: unit N gets a frozen view of the
  prior sink plus a writer scoped to its own section; the shared-mutable
  `handoff.x++` pattern dies. Skip if PR 1's completeness test already
  forecloses the regression class.

## 9. Acceptance invariants (testable, not aspirational)

1. Exactly one harness. `grep` finds no `recordLlmCost`, no event emission, no
   transcript write, no log-scope open in any phase or agent body outside
   `runUnit` / `HarnessCtx`.
2. Every phase and every agent implements `ExecutionUnit` and is registered;
   doc and refinement satisfy the same interface as axes.
3. Every unit declares its event set; a unit exiting without emitting it fails
   CI.
4. Every phase's run/skip condition is one named `PhaseGate` row in one table;
   pipeline.ts contains no inline phase-gating if/else; the spine is a
   procedural loop over the table, not a graph interpreter.
5. The §5 lifecycle fields are the only mutable `ctx` fields units touch.
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
