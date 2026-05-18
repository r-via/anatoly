# Observability Enforcement Contract (execution contract)

> Status: this document is the **execution contract** for the goal doc 14 §1
> named but deliberately delivered only as *centralization by convention*:
> **binding, standard observability for the whole pipeline, such that no
> process can make an LLM/agent call without its cost surfacing, run without
> emitting its events, log off the structured channel, or skip a uniform
> conversation dump.** It is the enforcement layer doc 14 set the seam for
> (`runUnit`) but left as pass-through: the cost/event *fold into the harness*
> was doc 14 PR 4c (declined) and the directional/enforcement layer was PR 6
> (declined), both as YAGNI because their payoff was *zero user-visible
> change*. This contract's payoff is different and concrete: **audit
> completeness** (a real cost leak exists today, §2) and the **cloud roadmap**
> (external/cloud consumption needs a binding observability contract). It is
> the structural sibling of
> [11](./11-Orchestration-Remediation-Plan.md) /
> [13](./13-Core-Module-Remediation-Plan.md) /
> [14](./14-Orchestration-Sink-Convention.md) and follows their proven shape
> (grounded diagnosis, ascending-risk PR sequence, testable invariants).
>
> Constraint set by the owner, verbatim in intent: *no process that fails to
> log in the right place or fails to return its LLM/agent costs.* Every step
> here is behavior-preserving by construction and bench-gated, or it does not
> ship.

## 1. The decision

Two stances on observability completeness:

- **Report-by-convention (today).** Each unit is trusted to call the right
  `recordXCost` helper, emit its events, use the structured logger, and pass
  `conversationDir`/`conversationPrefix`. Centralized helpers exist (doc 14)
  but nothing *forces* a unit through them. A new process (or an existing
  un-wired one) that forgets is silently invisible.
- **Capture-at-harness, enforced.** A unit does not *report* its
  observability: the single harness (`runUnit`) **captures** it because the
  unit cannot run except through the harness, and a binding CI/runtime
  invariant fails the build/run if any executed unit produced no cost / no
  events / an off-channel log / no conversation dump. The unit cannot forget
  because it never had the choice.

**Capture-at-harness is chosen.** Rationale, echoing doc 14 §1: a contract is
enforced by the single code path everything is obliged to take, plus an
invariant that fails when the path is bypassed. This is **not** a
relitigation of the declined PR 4c/6: those declined an internal
representation rewrite (accounting-as-projection) with no observable change.
This delivers a concrete correctness/audit guarantee (no silent cost leak, no
unlogged process) and the cloud-roadmap prerequisite.

## 2. Diagnosis (grounded)

Verified at HEAD `6962c51` (code tip; `efdada9` is doc-only), branch
`orchestration-sink-convention`, post doc-14 closure.

| Axis | Enforced today | Escape (grounded) |
|---|---|---|
| **Cost — ledger** (`costs/ledger.ndjson`, per-call) | transport-enforced: all 4 transports + `doc-llm-executor.ts:887` (doc-coherence manual) call `recordLlmCall` | **§7-A RESOLVED — ledger COVERED.** `doc-conflict-detector.ts` holds none of the LLM/cost primitives; the spine passes it `ctx.router`, so its call goes via the injected router -> a transport -> `recordLlmCall`. Not the worst case (it does *not* escape the ledger) |
| **Cost — rollup** (`run-metrics.json`: costUsd/providers/axisStats/phaseStats) | exactly 5 conventional feeders: `recordRagCost`, `recordAgentCosts`(review), `recordDocGenerationCost`(bootstrap+update via shared `runDocLlmPhase`), `recordDocCoherenceCost`, `recordRefinementCost` | **CONFIRMED, the one real cost leak: `doc-conflict-detection` feeds no `recordXCost`** -> its cost is absent from the rollup (v29 log shows it making LLM calls). No enforcement that an LLM-calling unit feeds the rollup |
| **Events** | phase boundary: `runPhase` fires `phase_start`/`phase_end` for **all 11** `CANONICAL_PHASES` (solid). Vocabulary typed (`ORCHESTRATION_EVENTS`, PR 1) | phase-**body** events emitted ad hoc per call site (PR 1 typed only the *names* via `satisfies`); the harness does not capture them; no runtime assertion that a unit emitted its declared set |
| **Logging** | structured: `getLogger()` (global pino), `ctx.runLog` (per-run -> `anatoly.ndjson`), `ctx.timeline` (-> run-metrics) | **§7-B RESOLVED — essentially NOT an escape.** Every `src/core` `console.*` is legitimate human terminal UX (run summary, dry-run, interrupted notices); observability (cost/events/timing/errors) already goes structured. Lone borderline: `calibration.ts:132` (a skipped-warning, console-only). De-scopes the former PR 5 to a one-line fix |
| **Conversations** (`runs/<id>/conversations/*.md`) | dumped via `conversationDir`/`conversationPrefix` threaded into `runSingleTurnQuery` + transports | `conversationPrefix` is **hand-built per call site** (`${slug}__${axisId}`), agent-by-agent, not harness-assigned: naming/coverage is by-convention; a unit can omit it or diverge the scheme |
| **Enforcement** | doc 14 §9 invariants are prose + one **static** test (events.test.ts asserts the contract map covers `CANONICAL_PHASES`) | **no runtime/CI invariant** fails when a unit runs without cost/events, logs off-channel, or skips a conversation dump. "Nothing escapes" is unenforced |

One sentence: phase-boundary observability is genuinely enforced; everything
inside a unit (cost rollup, body events, structured log, conversation dump)
is centralized-by-convention with at least one confirmed live leak
(doc-conflict-detection cost) and zero binding invariant.

## 3. The contract

For every **execution unit** (doc 14 §3: phase, and agent = axis / doc-gen /
doc-coherence / refinement / doc-conflict / RAG-summary), the harness
**captures**, the unit does not report:

1. **Cost.** Every unit that performs an LLM/agent call has its cost in both
   the ledger (`recordLlmCall`) and the in-memory rollup. The rollup entry is
   produced by the harness from the unit result, not by a hand-placed
   `recordXCost` in the phase body.
2. **Events.** Every unit emits its declared event set (boundary + the
   body events it owns); a typed registry maps unit -> required events.
3. **Logging.** Every observability signal (cost, event, error, phase timing)
   lands on the structured channel (`anatoly.ndjson` / timeline / ledger).
   Human terminal UX may still `console.*`, but no observability signal may
   exist *only* on `console`.
4. **Conversations.** Every unit's LLM interaction produces a conversation
   dump under `runs/<id>/conversations/` with a **harness-assigned** uniform
   name (`<unit-slug>__<unit-name>__<n>.md`), not a per-call-site string.

## 4. The enforcement mechanism

- **Capture in `runUnit`.** `runUnit` (already the single chokepoint every
  agent flows through, doc 14 PR 2a/3) stops being pure pass-through: it
  reads the unit result's cost/transcript and folds them into the rollup +
  ledger + a harness-assigned conversation dump. This is the cost/event
  *fold* doc 14 PR 2b/4a did at the phase grain by convention, now done by
  the harness so a unit cannot omit it. doc-conflict-detection and any other
  un-wired LLM path are brought through `runUnit`.
- **Binding invariant test (CI).** A test that runs the spine/handoff
  goldens and asserts: every executed `runPhase` produced phase_start/end;
  every unit that recorded a `recordLlmCall` also has a rollup entry (no
  ledger row without a matching rollup attribution); the unit-event registry
  is satisfied; `grep` finds no observability `console.*` in `src/core`
  pipeline code (allowlist for genuine UX). The build fails on a new escape.

## 5. Acceptance invariants (testable)

1. Every `recordLlmCall` ledger row maps to a rollup attribution (no
   LLM call absent from `run-metrics.json`); asserted on a hermetic run.
2. Every execution unit is registered with its required event set; a unit
   exiting without it fails CI (runtime, not just the static map).
3. No observability signal in `src/core` pipeline code reaches only
   `console.*` (allowlisted human-UX excepted).
4. Every unit LLM interaction yields exactly one harness-named conversation
   dump; `grep` finds no hand-built `conversationPrefix` in unit bodies.
5. Bench F1 within run-to-run noise of `0.6729` at every PR boundary.

## 6. PR sequence (ascending risk, per-PR gate)

- **PR 0 (done, `bcd54bf` + this update)** This contract; §7 audit items A/B/C
  resolved read-only; the true surface confirmed. No code.
- **PR 1 (done)** Plugged the confirmed leak. `detectNewConflictsViaLlm`
  surfaces each batch's `agenticQuery` cost via an optional `onLlmResponse`
  opt (DI, non-breaking); `runDocConflictDetection` accumulates it onto an
  optional `DetectionSummary.cost` (present only when the LLM ran);
  pipeline's two sites call the new harness-owned `recordDocConflictCost`
  (`orchestration/cost.ts`, phase = the verbatim runPhase name). Ledger was
  already covered (§7-A). **Behaviour-relevant by intent**: the run-metrics
  rollup now correctly includes doc-conflict cost (previously missing) — not
  byte-identical; the goldens are hermetic (doc-conflict skipped, no LLM, no
  change there) so this **requires its own bench** before merge. Gate:
  typecheck + 798 suites + goldens + extended `cost.test.ts` green; bench at
  the PR-1 tip.
- **PR 2 — full runUnit-capture restructure (owner decision, grounded at
  `9be2d16`).** "Make `runUnit` capture cost" is not one step: grounding
  shows runUnit is generic pass-through, result cost fields are non-uniform
  (`costUsd` vs `totalCostUsd`), runUnit wraps the single-turn *query* not
  the *axis* (per-axis rollup is aggregated in file-evaluator, the doc-14
  PR-2b grain wall), and rag-index / doc-conflict are not runUnit units.
  The owner chose the full restructure over the lean ledger<->rollup
  invariant: the structural "a unit cannot forget" guarantee, with the
  observability/audit + v30-pain justification (distinct from the YAGNI
  that declined doc-14 PR 4c; a **minimal cost-only** result contract is
  adopted, not the full form-first PhaseEnvelope doc-14 rejected).
  Decomposed by ascending risk, each behavior-preserving + bench-gated:
  - **PR 2a** Foundation, behavior-preserving: a minimal `UnitCost` shape;
    an optional cost-extractor on `ExecutionUnit` (the unit declares how to
    read its own cost, no uniform envelope forced); `HarnessCtx` gains an
    optional injected `recordCost?` sink (dependency inversion: orchestration
    injects it, `core/harness` stays zero-dep, no cycle). `runUnit` folds
    cost **only when** a unit provides the extractor AND the sink is present
    — no unit opts in yet, so runUnit stays pure pass-through, zero behavior
    change, the 6 `recordXCost` untouched. Pure DI scaffolding. Gate:
    typecheck + suites + goldens green (no behavior delta).
  - **PR 2b** The grain core (hard): wrap `AxisEvaluator.evaluate` as the
    §3-correct **agent-grain** unit (not the single-turn query), so per-axis
    cost (already aggregated in `AxisResult`) is captured at the unit
    boundary via the injected sink; the `recordAgentCosts(result.axisTiming)`
    loop in review.ts dies. Resolves the doc-14 PR-2b blocker by capturing
    at the axis, not the query. Behavior-relevant -> `cost.test.ts`
    byte-identical rollup + bench.
  - **PR 2c** Bring the non-unit LLM paths in: refinement / doc-gen /
    doc-coherence (already runUnit units) capture via the sink; rag-index
    and doc-conflict become `ExecutionUnit`s (or route their aggregate cost
    through the sink). Their `recordXCost` (incl. the PR-1
    `recordDocConflictCost`) become harness-internal. Gate: `cost.test.ts`,
    bench.
  - **PR 2d** All 6 `recordXCost` phase-body calls are gone (harness owns
    capture); fold in the binding ledger<->rollup CI invariant (former §6
    PR 4) as the completeness proof on top of the now-structural capture.
    Gate: the invariant test green on a hermetic run; bench.
- **PR 3** Harness-assigned conversation dumps (kill per-call-site
  `conversationPrefix`). Gate: goldens, conversation-naming test.
- **PR 4** Runtime unit-**event** registry + the event-completeness CI
  assertion + the `console` allowlist guard. (The ledger<->rollup cost
  invariant moved into **PR 2d**, where structural capture makes it the
  natural proof; PR 4 is now the events/log half only.) Gate: the new test
  green on a hermetic run; bench F1.
- **PR 5 (de-scoped by §7-B)** Not a migration: `src/core` `console.*` is
  legitimate human-UX. Only `calibration.ts:132` (a console-only
  skipped-warning) also gets a structured line. One-line fix, fold into
  PR 4 or skip.

## 7. Audit items — CLOSED (resolved read-only at `bcd54bf`)

- **A. RESOLVED — ledger covered.** `doc-conflict-detector.ts` holds none of
  `recordLlmCall`/`runSingleTurnQuery`/`runUnit`/`.query(`/Transport/cost
  primitives; the spine passes it `ctx.router`, so the call runs via the
  injected router -> transport -> `recordLlmCall`. doc-conflict escapes only
  the **rollup**, not the ledger (not the worst case).
- **B. RESOLVED — logging is not an escape.** All `src/core` `console.*` is
  human terminal UX (report.ts run summary, setup.ts dry-run, the
  interrupted notices, review.ts no-pending). Observability already goes
  structured. Lone borderline `calibration.ts:132`. PR 5 de-scoped to a
  one-liner.
- **C. RESOLVED — inventory complete.** `.query({` outside transports is
  only the single-turn path (already `runUnit`). `triage` / `estimator` /
  `scanning` make no LLM call (deterministic). **`doc-conflict-detection` is
  the only LLM-calling unit not on `runUnit`.** No hidden path.

Net of the completed audit: the true surface is **smaller** than the initial
draft feared. Real work = (1) the one rollup leak (doc-conflict), (2)
conversation-name uniformity, (3) harness-capture so the rollup is not
phase-reported, (4) the binding invariant. Logging is fine; the event gap is
"no runtime completeness assertion", not "events escape".

## 8. Why this is not the declined PR 4c / PR 6

PR 4c declined *accounting-as-projection*: an internal representation rewrite
with zero observable change, motivation already met by centralization. PR 6
declined a *speculative* directional-capability surface guarding a
zero-evidence regression class. This contract is neither: it closes a
**grounded, live** observability leak (doc-conflict cost absent from
run-metrics today), makes "nothing escapes" a **binding invariant** rather
than prose, and is justified by audit correctness and the cloud roadmap, not
aesthetics. It uses the seam doc 14 built; it does not rebuild it.
