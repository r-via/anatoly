# Orchestration golden fixture

A deliberately source-free project used by
[`src/core/orchestration/spine-golden.test.ts`](../../core/orchestration/spine-golden.test.ts).

It exists to drive a full `anatoly run` through the real orchestration spine
with **zero LLM calls**, so the run is fully deterministic and hermetic
(no provider credentials, no network).

Why source-free: with no evaluable files the review phase reviews nothing, so
no axis ever calls a model. The run still traverses every unconditional phase
(`scan`, `estimate`, `triage`, `rag-index`, `review`, `report`) and skips every
gated phase (`bootstrap-doc`, `doc-conflict-*`, `internal-docs`, `refinement`)
exactly as the spine dictates. The golden asserts that observed sequence.

The test runs with `ANATOLY_TRANSPORT=replay` and an empty cassette path. If any
phase ever makes a model call, the recording transport throws a `cassette miss`
and the run aborts: the golden passing therefore also proves this fixture stays
at zero model calls.

Do not add source files here. A richer cassette-backed fixture that exercises
real axis output is a separate, follow-up golden (seed its cassette once with
`ANATOLY_TRANSPORT=record` against live models).
