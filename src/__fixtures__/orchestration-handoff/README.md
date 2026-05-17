# Orchestration handoff golden fixture

Companion to the source-free
[orchestration-golden](../orchestration-golden/README.md) fixture, used by
[`src/core/orchestration/handoff-golden.test.ts`](../../core/orchestration/handoff-golden.test.ts).

Where the spine golden asserts the phase *sequence* with zero handoff values
(source-free, `filesReviewed=0`, `findings=0`), this fixture drives a run that
produces **non-zero, deterministic** inter-phase handoff values
(`filesReviewed=1`, `evaluated=1`, `findings=6`) so the golden actually
constrains the §4 setup -> review -> report handoff that doc 11 PR 8c inverts
from `ctx` mutation to a typed object.

Still hermetic and zero-LLM: [`src/dead.ts`](./src/dead.ts) has exports nothing
imports, so `UtilityEvaluator` resolves each symbol as DEAD straight from the
usage graph with no model call. Only the `utility` axis is enabled; rag, docs,
agents are off. The test runs under `ANATOLY_TRANSPORT=replay` with an empty
cassette, so any model call would `cassette miss` and fail the test.

The run exits with code 1 (findings present); that is expected and asserted.
Do not import `src/dead.ts` and do not "fix" its dead code: the DEAD verdicts
are the fixture's purpose.
