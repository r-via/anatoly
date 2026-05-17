# Orchestration Runtime (canonical reference)

> Status: this document is the **contract** for how `anatoly run` orchestrates
> phases, agents and data. It is written **before** the Epic 56 remediation, so
> every section carries an explicit implementation status. Sections marked
> CONTRACT describe the intended invariant; sections marked REALITY describe
> what the code does today (verified against source at the commit this file was
> added). Where they diverge, that divergence is the remediation backlog.
>
> Supersedes, at the orchestration level, the higher-level narratives in
> [01-Pipeline-Overview.md](./01-Pipeline-Overview.md) and
> [03-Data-Flow.md](./03-Data-Flow.md), which predate the 11-phase model and
> the four-plane dataplane and are now partially inaccurate.
>
> **Remediation status (updated in lockstep).** The divergence is being closed
> by [11-Orchestration-Remediation-Plan.md](./11-Orchestration-Remediation-Plan.md)
> under **Strategy B**: extract the live spine out of `run.ts`, and **delete**
> (not wire) the unused Epic 56 scaffolding.
>
> **PR 1 has landed.** The registry / executor / exchange / gateway are no
> longer "backlog", they are **removed**, and the clauses that depended on them
> are recast as explicit non-goals (see the markers in §1, §6, §7, §8). The
> regression suite is no longer hollow: a real spine golden now exists
> ([spine-golden.test.ts](../../src/core/orchestration/spine-golden.test.ts)).
>
> **PRs 2 to 7 have landed.** All seven phase implementations were extracted
> byte-verbatim out of `run.ts` (3360 to ~1065 lines) into dedicated modules.
> The inline `run.ts:NNN` / `run.ts#L...` anchors in §2 to §6 below are
> **pre-extraction and superseded**: the phase *sequencing and gates* still
> live in the `run.ts` spine, but every phase *body* now lives here:
>
> | Phase(s) | Module |
> |---|---|
> | scan / estimate / triage (setup stage) | [phases/setup.ts](../../src/core/orchestration/phases/setup.ts) |
> | bootstrap-doc / internal-docs (+ doc-gen helper, post-update reindex) | [phases/doc.ts](../../src/core/orchestration/phases/doc.ts) |
> | rag-index | [phases/rag.ts](../../src/core/orchestration/phases/rag.ts) |
> | review (+ cache helpers) | [phases/review.ts](../../src/core/orchestration/phases/review.ts) |
> | refinement | [phases/refinement.ts](../../src/core/orchestration/phases/refinement.ts) |
> | report | [phases/report.ts](../../src/core/orchestration/phases/report.ts) |
>
> Cross-cutting helpers also relocated: `recordLlmCost`
> ([cost.ts](../../src/core/orchestration/cost.ts)), `requestFatalStop`
> ([run-control.ts](../../src/core/orchestration/run-control.ts)); the
> inter-phase types `SetupResult` / `RagContext` now live in
> [handoff.ts](../../src/core/orchestration/handoff.ts). The
> `doc-conflict-bootstrap` / `doc-conflict-update` `runPhase` wrappers remain in
> the spine. **PR 8 (pending)** moves the spine itself into `pipeline.ts` and
> replaces the `ctx`-mutation handoff with the typed `handoff.ts` object; §2 to
> §4 below will be rewritten then. Until then, read the `run.ts:NNN` anchors as
> "this logic, now in the module above", not literal line numbers.

## 1. The orchestration model

CONTRACT. Anatoly is one orchestrator driving a fixed, ordered set of
**phases**. A phase is a named unit of work with a single boundary wrapper.
A phase may invoke one or more **agents** (also called primitives: a single
LLM call or an agentic tool loop). Agents never talk to each other directly
and never reach a provider on their own terms: every agent call passes through
one seam that produces four strictly dissociated artefacts, the **dataplane**:

| Plane | Name | Carries | One consumer class |
|------|------|---------|--------------------|
| D.1 | Typed data | Zod-validated structured result of a call | the next agent / the merger |
| D.2 | Conversation dump | full prompt+response transcript | humans, replay, post-mortem |
| D.3 | Execution log | NDJSON events (phase/agent lifecycle, cost headline) | watch UI, `jq`, attach |
| D.4 | Cost ledger | per-call cost/token record + pre-flight estimate | cost summary, variance, cloud |

The four invariants that make this a contract, not a convention:

1. **Phase boundary is mandatory.** Every phase runs through `runPhase`. No
   phase emits its own start/end/duration plumbing. Drift at the boundary is
   structurally impossible because a phase that does not call `runPhase` is
   invisible and unmergeable.
2. **Single agent seam.** Every LLM/agent call passes through one gateway that
   mints a `callId` and opens the orchestration scope
   (`phase` + `composer` + `primitive` + `callId`). No call site reaches a
   transport by another path.
3. **Four-plane dissociation.** D.1/D.2/D.3/D.4 share only the `callId`. No
   plane carries another plane's fields (no prompt in D.4, no cost detail in
   D.1, no NDJSON event in D.2).
4. **The data stream is centralized.** A phase's output that a later phase
   needs is published to a known store, not threaded ad hoc through closures
   and `RunContext` mutation. A later agent reads upstream results from that
   store, never from a sibling agent.

REALITY (summary; detail in §7). Invariant 1 holds and is now enforced at
runtime (the spine golden, not a source grep). Invariants 2 and 4 are
**recast as non-goals** by Strategy B (doc 11): the gateway, the registry
dispatch and the central exchange were declared modules that nothing invoked,
so PR 1 deleted them rather than wiring them. The accepted seam is the four
transports each doing their own recording, plus the ALS-scoped D.4 sink
(§6). The data stream is threaded through `setup` return values, `ragContext`,
and `ctx` mutation; doc 11 replaces that with a typed handoff store (doc 11
§4), not the deleted exchange. Invariant 3 (four-plane dissociation) stands as
written. The Epic 56 scaffolding under `src/core/orchestration/` is gone; what
remains there is load-bearing: `run-phase.ts` (the boundary) and the spine
golden.

## 2. Canonical phases

CONTRACT. The pipeline is exactly these 11 phases, in this order, declared once
in [run-phase.ts](../../src/core/orchestration/run-phase.ts#L17) as
`CANONICAL_PHASES`. `scan`, `estimate`, `triage` run inside the setup stage;
the rest run from the orchestration spine in
[run.ts](../../src/commands/run.ts#L918).

| # | Phase | Gate (runs only if) | LLM? | Agents invoked |
|---|-------|---------------------|------|----------------|
| 1 | `scan` | always | no | none (tree-sitter, hashing) |
| 2 | `estimate` | always | no | none (token math) |
| 3 | `triage` | always | no | none (heuristics) |
| 4 | `bootstrap-doc` | first run AND doc axis active AND doc mode not `off`/`lite` | yes | `agents.doc-generator` |
| 5 | `doc-conflict-bootstrap` | after `bootstrap-doc`, not interrupted | yes | `agents.doc-conflict-detector` |
| 6 | `rag-index` | always wrapped; body no-ops if `rag.enabled: false` | yes | `rag.nlp-summary` (code embed + `rag.doc-chunk` are local) |
| 7 | `internal-docs` | doc mode not `off`/`lite` AND evaluable files exist | yes | `agents.doc-generator` |
| 8 | `doc-conflict-update` | after `internal-docs`, not interrupted | yes | `agents.doc-conflict-detector` |
| 9 | `review` | always (pass 1) | yes | 7 axes (one is 2-pass) + `axis-merger` (local) |
| 10 | `refinement` | `deliberation` enabled AND `filesReviewed > 0` | yes | `agents.tier3-deliberator` (tiers 1+2 local) |
| 11 | `report` | always | no | none (reporter + badge) |

REALITY. Verified at [run.ts:919](../../src/commands/run.ts#L919) (`runSetupPhase`),
[988](../../src/commands/run.ts#L988) (`bootstrap-doc`),
[1006](../../src/commands/run.ts#L1006) (`doc-conflict-bootstrap`),
[1019](../../src/commands/run.ts#L1019) (`rag-index`),
[1035](../../src/commands/run.ts#L1035) (`internal-docs`),
[1057](../../src/commands/run.ts#L1057) (`doc-conflict-update`),
[1079](../../src/commands/run.ts#L1079) (`review`),
[1093](../../src/commands/run.ts#L1093) (`refinement`),
[1219](../../src/commands/run.ts#L1219) (`report`). The split of the old
`doc-conflict-detection` into `doc-conflict-bootstrap` / `doc-conflict-update`
(Epic 56 FR14) is real and each has a distinct `phaseDurations` key. The
duplicate-phase guard is real ([run-phase.ts:108](../../src/core/orchestration/run-phase.ts#L108)).
`provider-check` and `vercel-agent` are NOT pipeline phases (see §5).

### Per-phase detail

**1. scan** ([run.ts:1470](../../src/commands/run.ts#L1470), `scanProject`).
Walks include/exclude globs, parses each file with tree-sitter, extracts
symbols, SHA-256 hashes content. Also builds the usage graph, dependency
metadata and project tree inside the setup stage (these were a separate
"usage-graph" phase in the old docs; they are not a canonical phase).
Output: `Task[]` to `.anatoly/cache/tasks/*.task.json`, threaded as
`setup.tasks` / `setup.usageGraph` / `setup.depMeta` / `setup.projectTree`.
Consumes: nothing upstream. Cost: zero.

**2. estimate** ([run.ts:1486](../../src/commands/run.ts#L1486)). Token/time
budget from the task list. Output: in-memory estimate + screen summary.
Cost: zero.

**3. triage** ([run.ts:1517](../../src/commands/run.ts#L1517)). Classifies
each file `skip` | `evaluate`. Output: `setup.triageMap`, the gate for
`review` and for `internal-docs` (`hasEvaluableFiles`,
[run.ts:1026](../../src/commands/run.ts#L1026)). Cost: zero.

**4. bootstrap-doc** ([run.ts:988](../../src/commands/run.ts#L988),
`runDocBootstrap`). First run only. Scaffolds `.anatoly/docs/` then generates
each page via `agents.doc-generator`. On success writes the scaffold status
tag so future runs do not re-bootstrap. Consumes: `setup.tasks`. Produces:
`.anatoly/docs/` pages, doc flag ledger v3.

**5. doc-conflict-bootstrap** ([run.ts:1006](../../src/commands/run.ts#L1006),
`runDocConflictDetection`). Detects contradictions between human reference
docs and generated fragments via `agents.doc-conflict-detector`. Consumes:
generated docs from phase 4 + `setup.tasks`. Produces: arbitrated-fragment
lock state under `state/internal-docs`.

**6. rag-index** ([run.ts:1019](../../src/commands/run.ts#L1019),
`runRagPhase`). Wrapped unconditionally; body short-circuits when RAG is off.
Three sub-steps: local code embedding (zero LLM), `rag.nlp-summary` (the only
LLM call here, Haiku, cached), `rag.doc-chunk` (programmatic `smartChunkDoc`,
zero LLM today, see §5 note). Consumes: `setup.tasks` + generated docs.
Produces: LanceDB vector store + caches; returned as `ragContext`.

**7. internal-docs** ([run.ts:1035](../../src/commands/run.ts#L1035),
`runDocUpdate`). Regenerates only docs whose source changed, via
`agents.doc-generator`; then re-chunks and re-embeds changed docs into the
vector store ([run.ts:1043](../../src/commands/run.ts#L1043)). Consumes:
`setup.tasks`, `ragContext.vectorStore`. Produces: updated `.anatoly/docs/`.

**8. doc-conflict-update** ([run.ts:1057](../../src/commands/run.ts#L1057)).
Same agent as phase 5, run after the doc update. Produces arbitrated fragments
loaded onto `ctx.arbitratedFragments` at
[run.ts:1073](../../src/commands/run.ts#L1073) so the review axes can consume
them.

**9. review** ([run.ts:1079](../../src/commands/run.ts#L1079),
`runReviewPhase`). Worker pool over evaluable files; per file, 7 axes run in
parallel via `Promise.allSettled`, then `axis-merger` merges them into one
`ReviewFile`. Consumes: `setup.triageMap`, `setup.usageGraph`, `ragContext`,
`setup.depMeta`, `setup.projectTree`, `setup.docsTree`,
`setup.internalDocsTree`, `ctx.arbitratedFragments`. Produces: per-file
`ReviewFile` (content-addressable store + per-run snapshot).

**10. refinement** ([run.ts:1093](../../src/commands/run.ts#L1093),
`runRefinementPhase`). Tier 1 deterministic auto-resolve (zero LLM), tier 2
inter-axis coherence (zero LLM), tier 3 agentic investigation via
`agents.tier3-deliberator` (budget-capped). Consumes: `ReviewFile`s from
phase 9, `setup.usageGraph`. Produces: refined `ReviewFile`s, reclassification
records, updates `ctx.totalFindings`.

**11. report** ([run.ts:1219](../../src/commands/run.ts#L1219),
`runReportPhase`). Aggregates all `ReviewFile`s into reports + `run-metrics.json`,
optionally injects the README badge. Consumes: all `ReviewFile`s. Cost: zero.

## 3. Phase sequencing and the data stream

CONTRACT. Downstream phases consume upstream output through one published
store, keyed so a later agent can pull exactly the upstream result it needs
without touching a sibling.

REALITY. The data stream is real and correct in content, but the transport is
ad hoc:

```
runSetupPhase ──returns──> setup{tasks,triageMap,usageGraph,depMeta,
                                  projectTree,docsTree,internalDocsTree,...}
      │
      ├─ bootstrap-doc ─writes─> .anatoly/docs/ ──┐
      │                                           │
      ├─ doc-conflict-bootstrap ─writes─> state/internal-docs (lock)
      │                                           │
      ├─ rag-index ──returns──> ragContext{vectorStore} <── reads .anatoly/docs/
      │                                           │
      ├─ internal-docs ─writes─> .anatoly/docs/ ; re-embeds into ragContext
      │
      ├─ doc-conflict-update ─writes─> arbitrated fragments
      │        └─ loaded onto ctx.arbitratedFragments (run.ts:1073)
      │
      ├─ review(setup.*, ragContext, ctx.arbitratedFragments)
      │        └─writes─> ReviewFile (cache + run snapshot)
      │
      ├─ refinement ─reads─> ReviewFile ─writes─> refined ReviewFile
      │
      └─ report ─reads─> all ReviewFile ─writes─> reports + run-metrics.json
```

The handoff mechanism is three different things at once: (a) the `setup`
return object, (b) the `ragContext` return object, (c) `RunContext` field
mutation (`ctx.arbitratedFragments`, `ctx.totalFindings`, `ctx.filesReviewed`).
There is no single typed store and no schema on the boundary. The Epic 56
central exchange that was meant to replace (c) has been **deleted** (doc 11
PR 1): it was never instantiated at runtime. The Strategy B replacement is a
typed handoff store extracted alongside the spine (doc 11 §4), scoped to the
real inter-phase subset, not a generic exchange.

## 4. The four-plane dataplane

CONTRACT. For every agent call, exactly four artefacts, joined only by
`callId`. Roles and consumers below.

### D.1 Typed data

- Role: the structured result that feeds the next step.
- CONTRACT producer: the agent gateway, validated against the primitive's
  `response.outputSchema`, written to the central exchange; snapshot at
  `runs/<id>/conversations/{phase}__{composer}__exchange__{callId}.json`.
- CONTRACT consumer: the next composer step / the axis-merger.
- REALITY: **not produced as a plane.** Axis results are `AxisResult` objects
  returned in-memory, merged by [axis-merger.ts](../../src/core/axis-merger.ts)
  into a `ReviewFile` written to `.anatoly/cache/reviews/<hash>.rev.json` and
  the per-run `runs/<id>/reviews/`. There is no exchange snapshot. D.1 today
  is the `ReviewFile`, not a typed-handoff plane.

### D.2 Conversation dump

- Role: human-readable transcript of one call, for replay and post-mortem.
- CONTRACT location:
  `runs/<id>/conversations/{phase}__{composer}__{primitive}__{callId}__{attempt}.{md|json}`,
  the name produced by one centralized function from the orchestration scope.
- CONTRACT consumer: humans, `--report` tooling (globs the directory, never
  parses the name).
- REALITY: **legacy ad-hoc naming.** `buildDumpSlug()`
  ([conversation-dump.ts:16](../../src/core/transports/conversation-dump.ts#L16))
  has zero production call sites. `callId` is never minted (only read in the
  pino binding at [log-context.ts:86](../../src/utils/log-context.ts#L86)).
  Each call site passes a free-form `conversationPrefix` (alive in 17 files:
  the 7 axes, [axis-evaluator.ts](../../src/core/axis-evaluator.ts),
  [nlp-summarizer.ts](../../src/rag/nlp-summarizer.ts),
  [doc-indexer.ts](../../src/rag/doc-indexer.ts),
  [doc-conflict-detector.ts](../../src/core/doc-conflict-detector.ts), and
  `tier3-shard-${Date.now()}` at
  [run.ts:1121](../../src/commands/run.ts#L1121)), so dumps land as e.g.
  `src-engine__correction__1.md`. This is the defect specified in
  [spec-conversation-dump-naming-correction.md](../../_bmad-output/planning-artifacts/spec-conversation-dump-naming-correction.md).

### D.3 Execution log

- Role: structured event stream for the watch UI, `attach`, and `jq`.
- Location: `runs/<id>/logs/anatoly.ndjson` (pino), plus the in-memory
  `ctx.timeline` and `ctx.pipelineState`.
- CONTRACT producer: `runPhase` for phase events; the gateway for
  `resource_call_*` / `cache_*` / `retry_*`; one versioned vocabulary in
  [execution-events.ts](../../src/schemas/execution-events.ts).
- Consumer: `ndjson-tail` / `attach`, the screen renderer via `pipelineState`.
- REALITY: phase events are emitted correctly and symmetrically by `runPhase`
  ([run-phase.ts:119-189](../../src/core/orchestration/run-phase.ts#L119)).
  `resource_call_*` events are emitted from inside the transports, not a
  gateway. The 16-event v1 vocabulary schema exists; it is not enforced at the
  emit sites.

### D.4 Cost ledger

- Role: one record per call (actual) plus pre-flight estimate; the basis for
  cost summary, variance and the cloud roadmap aggregates.
- Location: `runs/<id>/costs/ledger.ndjson`, derived
  `costs/summary.json` and `costs/variance.json`.
- Producer: `recordLlmCall()`
  ([llm-calls-sink.ts](../../src/utils/llm-calls-sink.ts), schema v2,
  ALS-scoped, append-only).
- Consumers: `writeCostSummary` / `writeCostVariance`
  ([llm-calls-sink.ts:312](../../src/utils/llm-calls-sink.ts#L312),
  [374](../../src/utils/llm-calls-sink.ts#L374)),
  `run-metrics.json`, `calibration.ts`, the cloud roadmap.
- REALITY: schema v2 landed, ledger path renamed to `costs/ledger.ndjson`
  ([run.ts:931](../../src/commands/run.ts#L931)), summary/variance writers
  wired. **But** the central sink is invoked from inside each of the four
  transports separately, not from one gateway, and the `composer`/`primitive`
  scope is opened only on the axis path
  ([axis-evaluator.ts:398](../../src/core/axis-evaluator.ts#L398), Story 56.11).
  Non-axis calls (`nlp-summary`, `doc-conflict-detector`, `doc-generator`,
  `tier3-deliberator`) produce ledger records without composer/primitive
  attribution. The cloud prerequisite (phase x composer x primitive x provider)
  is therefore only partially satisfied today.

### Non-plane run artefacts (the real outputs)

These are not part of the four-plane contract but are the pipeline's primary
outputs and must stay listed for the data-visibility goal:

| Artefact | Producer | Consumer(s) | Lifetime |
|---|---|---|---|
| `Task[]` `.anatoly/cache/tasks/*.task.json` | [scanner.ts:444](../../src/core/scanner.ts#L444) | estimator, RAG indexer | shared, per-file hash |
| `ReviewFile` cache `.anatoly/cache/reviews/<h>.rev.json` | [project-review-cache.ts](../../src/core/project-review-cache.ts#L62) | reporter, next run (cache hit) | shared, content-addressable |
| review index `.anatoly/cache/review-index.json` | project-review-cache | cache lookup | shared |
| `progress.json` | [progress-manager.ts:92](../../src/core/progress-manager.ts#L92) | `report`, `status` commands | shared |
| LanceDB `.anatoly/cache/rag/lancedb/` | vector-store | review (per-file doc retrieval) | shared |
| RAG + NLP caches | rag indexer | next RAG index (skip unchanged) | shared |
| doc flag ledger v3 `.anatoly/cache/doc-build/manifest.json` | [doc-cache.ts:240](../../src/core/doc-cache.ts#L240) | doc pipeline (skip done work) | shared |
| generated docs `.anatoly/docs/` | doc-scaffolder | reporter, RAG doc-indexer, correction axis | shared |
| per-run reviews `runs/<id>/reviews/*.rev.json`/`.md` | [review-writer.ts:31](../../src/core/review-writer.ts#L31) | reporter, `report` command | per-run snapshot |
| `run-metrics.json` | [run.ts:3191](../../src/commands/run.ts#L3191) | `report`, `runs`, `calibration`, bench | per-run |
| `report.md` / `public_report.md` / `axes/*` | [reporter.ts:2271](../../src/core/reporter.ts#L2271) | users, CI, bench scorer | per-run |
| `run-config.json` | [run-config.ts:107](../../src/core/run-config.ts#L107) | post-run reproducibility | per-run |

## 5. Agent catalog

CONTRACT. Every entry below is a named primitive with one model resolver, one
typed response schema, one dump block, one cost capture mode, invoked only via
the gateway. The declarations exist in
[registry/primitives/](../../src/core/orchestration/registry/primitives/);
the dispatch does not (see §7).

| Primitive | Phase | Type | Model (config key) | Consumes | Produces | Gate |
|---|---|---|---|---|---|---|
| `axes.utility` | review | single | `axes.utility.model` / fast (Haiku) | file + symbols + usage graph | USED/DEAD/LOW_VALUE | only if a symbol cannot be auto-resolved from the usage graph |
| `axes.duplication` | review | single | `axes.duplication.model` / fast | file + RAG similars | UNIQUE/DUPLICATE | evaluable file |
| `axes.correction-pass1` | review | single | `axes.correction.model` / quality (Sonnet) | file + docs + deps | OK/NEEDS_FIX/ERROR + findings | evaluable file |
| `axes.correction-verify` | review | single (pass 2) | same as pass1 | pass1 findings + dep READMEs | reclassified findings | `fileDeps` present AND a NEEDS_FIX/ERROR exists ([correction.ts:362](../../src/core/axes/correction.ts#L362)) |
| `axes.overengineering` | review | single | `axes.overengineering.model` / fast | file + symbols | LEAN/OVER/ACCEPTABLE | evaluable file |
| `axes.tests` | review | single | `axes.tests.model` / fast | file + test file | GOOD/WEAK/NONE | evaluable file |
| `axes.best-practices` | review | single | `axes.best_practices.model` / quality | file + context | verdict + scored rules | evaluable file |
| `axes.documentation` | review | single | `axes.documentation.model` / fast | file + internal docs | DOCUMENTED/PARTIAL/UNDOCUMENTED | evaluable file (skipped for type-only/constants) |
| `rag.nlp-summary` | rag-index | single | `models.code_summary` ?? fast | function cards | per-function summary + concepts | `cards.length > 0`, optional (falls back) |
| `rag.doc-chunk` | rag-index | **programmatic today** | n/a (`smartChunkDoc`) | markdown docs | sections to embed | doc SHA changed. Registry still declares it single-turn: a registry/reality mismatch to resolve |
| `agents.doc-conflict-detector` | doc-conflict-bootstrap, doc-conflict-update | agentic (no tools) | `agents.review` ?? quality | reference docs + generated fragments + code surface | detected conflicts | doc mode not `off`, router present, inputs non-empty |
| `agents.doc-generator` | bootstrap-doc, internal-docs | agentic | per page, default Sonnet | page context (tree, exports, neighbors) | page markdown | `prompts.length > 0` |
| `agents.tier3-deliberator` | refinement | agentic | `agents.deliberation` ?? `models.deliberation` | escalated findings (sharded) + ReviewFile | reclassifications | deliberation on, escalations exist, budget not exhausted (cap ~$30) |

Local (zero-LLM) steps that are part of orchestration but are not agents:
usage-graph build, `axis-merger` ([axis-merger.ts](../../src/core/axis-merger.ts)),
refinement tier 1 and tier 2, code embedding, `smartChunkDoc`, reporter, badge.

Not pipeline primitives (documented to prevent miscounting):

- `misc.provider-check` ([providers.ts](../../src/commands/providers.ts)): the
  `anatoly providers` health command, not part of `anatoly run`.
- `agents.vercel-agent` ([vercel-agent.ts](../../src/core/agents/vercel-agent.ts)):
  the agentic path inside the Vercel SDK transport, reached only when a
  provider routes through that transport, not a standalone pipeline step.

### The review handoff (axes to ReviewFile to refinement)

`runReviewPhase` (worker pool) per file: 7 axes via `Promise.allSettled`
=> `AxisResult[]` => `mergeAxisResults`
([axis-merger.ts](../../src/core/axis-merger.ts)) applies coherence rules,
dedups actions, computes the file verdict => one `ReviewFile` written to the
content-addressable cache and the run snapshot. `refinement` then reads those
`ReviewFile`s: tier 1 (deterministic) and tier 2 (coherence) resolve or
escalate; tier 3 sends escalations in module-grouped shards to
`agents.tier3-deliberator`, applies reclassifications back to the `ReviewFile`,
and adjusts `ctx.totalFindings`. `report` reads the final `ReviewFile` set.

## 6. The agent seam today

CONTRACT. One gateway. Every primitive call goes through it; it mints `callId`,
opens `runWithContext({ composer, primitive, callId })`, invokes the transport,
and is the single place D.2/D.3/D.4 are emitted with a shared `callId`.

REALITY. There is no gateway module, and under Strategy B there will not be
one: the `executor.ts` that took an unconstructed `gateway` parameter has been
**deleted** (doc 11 PR 1). The de-facto seam below is now the **accepted**
seam, not a backlog gap. It is split five ways:

- single-turn axes + `rag.nlp-summary`: `runSingleTurnQuery`
  ([axis-evaluator.ts:362](../../src/core/axis-evaluator.ts#L362)) =>
  `router.acquire()` => `transport.query()`.
- `agents.doc-conflict-detector`: `router.agenticQuery()`
  ([doc-conflict-detector.ts:497](../../src/core/doc-conflict-detector.ts#L497)).
- `agents.doc-generator`: injected executor =>
  [doc-llm-executor.ts](../../src/core/doc-llm-executor.ts).
- `agents.tier3-deliberator`: injected `queryFn` =>
  `router.agenticQuery()` ([run.ts:1111](../../src/commands/run.ts#L1111)).
- transports themselves
  ([anthropic-transport.ts](../../src/core/transports/anthropic-transport.ts),
  gemini, vercel-sdk) each call `recordLlmCall()` and `initConvDump()`
  directly.

The one thing that is de-facto central is the D.4 sink, only because it is
ALS-scoped and every transport happens to call it. D.2 and the `callId` join
cannot be unified without first building the seam this section describes.

## 7. Implementation status vs contract (remediation backlog seed)

Honest scorecard. This table is the point of the document: it is what the
remediation must close. Verified against source.

| Contract clause | Epic 56 ref | Status | Evidence |
|---|---|---|---|
| Phase boundary mandatory (`runPhase`, 8 effects, dup guard, fail-fast) | Pillar A, FR1/FR2/FR15 | ✅ enforced | [run-phase.ts](../../src/core/orchestration/run-phase.ts), 12 call sites in run.ts |
| `doc-conflict` split into two named phases | FR14 | ✅ enforced | [run.ts:1006](../../src/commands/run.ts#L1006), [1057](../../src/commands/run.ts#L1057) |
| D.4 sink schema v2 + ledger path + summary/variance writers | FR7/FR8/FR10 | ✅ landed | [llm-calls-sink.ts:74](../../src/utils/llm-calls-sink.ts#L74), [run.ts:931](../../src/commands/run.ts#L931) |
| D.4 composer/primitive attribution on every call | FR5/Story 56.11 | 🟡 axis path only | [axis-evaluator.ts:398](../../src/core/axis-evaluator.ts#L398); non-axis calls unattributed |
| Single agent gateway, `callId` minted once per call | FR2 (spec)/Pillar B | ❌ REMOVED | Strategy B non-goal; gateway never existed, `callId` stays unminted by design (doc 11 PR 1) |
| Composer registry dispatched at runtime | Pillar B.2, FR4/FR5 | ❌ REMOVED | `registry/` deleted (doc 11 PR 1); had zero runtime lookups |
| DAG executor invoked | FR5 | ❌ REMOVED | `executor.ts` deleted (doc 11 PR 1); had zero callers |
| Central exchange (D.1 plane + snapshot) | Pillar C, FR6 | ❌ REMOVED | `exchange.ts` deleted (doc 11 PR 1); replaced by a typed handoff store (doc 11 §4) |
| D.2 centralized naming `{phase}__{composer}__{primitive}__{callId}` | FR16/Story 56.6 | 🟡 DEFERRED | needs a gateway Strategy B does not build; tracked by the dump-naming spec, not carried as dead code |
| `axes.correction` split into pass1/verify | FR13 | 🟡 split exists | pass1/verify live in [correction.ts](../../src/core/axes/correction.ts); the dead "orchestrating composer" framing is removed with the registry |
| Four-artefact separation | NFR6 | 🟡 runtime, not lint | D.1..D.4 dissociation holds in the transports + D.4 sink; the registry-inspection lint is gone with the registry |
| Regression suite makes drift unmergeable | Story 56.10, NFR5 | ✅ enforced | [spine-golden.test.ts](../../src/core/orchestration/spine-golden.test.ts) drives a full `anatoly run` and asserts the phase sequence + gates + handoff; proven to fail on a deliberate spine drift (doc 11 PR 1) |

Reading of the scorecard (post doc 11 PR 1): Pillar A (phase runtime) is real,
trustworthy, and now guarded by a runtime golden rather than a source grep.
Pillar D.4 (cost) is structurally there but under-attributed. Pillars B
(registry + executor + gateway) and C (exchange / D.1) are **removed**: under
Strategy B they are non-goals, not unwired backlog. D.2 centralized naming is
**deferred** behind a gateway that Strategy B does not build (a tracked spec,
not dead code). The previously most dangerous line (the hollow safety net) is
closed: the spine golden exercises the real runtime. One guard finding from the
deletion: `cost-integrity.test.ts` and `plan-fidelity.test.ts` were verified to
test the **live** cost sink (`writeCostSummary` / `writeCostVariance`), not the
dead scaffolding, so they were kept; this document's earlier blanket "hollow"
label for `cost-integrity` was inaccurate and is corrected here.

## 8. Invariants the remediation must enforce

Split into what Strategy B enforces now and what it explicitly defers. Written
so a test can fail on regression and pass only when the property holds.

### Enforced now (doc 11 PR 1)

1. **Spine fidelity.** A full `anatoly run` driven through the real spine
   produces exactly the canonical phase sequence for the run's gate inputs,
   with each executed phase routed through `runPhase` (observed in
   `run-metrics.json`, not a source grep). Deleting or reordering any
   `runPhase(...)` call, or taking a phase off the wrapper, fails
   [spine-golden.test.ts](../../src/core/orchestration/spine-golden.test.ts).
   Hermetic: the run executes under `ANATOLY_TRANSPORT=replay` so any model
   call throws `cassette miss` and fails the test.
2. **Determinism guard.** A recorded run replays byte-stable on a fixed
   fixture: the deterministic transport double
   ([recording-transport.ts](../../src/core/transports/recording-transport.ts))
   keys requests by normalized content so a cassette captured in one temp root
   replays in another.

### Deferred (depend on a gateway Strategy B does not build)

These were invariants for the gateway/registry/exchange that PR 1 removed. They
are not abandoned silently: they are parked behind the dump-naming spec and
will be rewritten if and when a real gateway is ever justified. They are NOT
carried as dead code or as a hollow passing test.

- `callId` minted once per call, joining exactly one D.4 record, one D.3
  `resource_call_*`, and one D.2 file named
  `{phase}__{composer}__{primitive}__{callId}__{attempt}`.
- Zero `conversationPrefix` in production; one producer for the dump name.
- Every D.4 record for a dump-enabled primitive has non-empty
  `composer`/`primitive` (no axis-only attribution).

## See also

- [spec-conversation-dump-naming-correction.md](../../_bmad-output/planning-artifacts/spec-conversation-dump-naming-correction.md)
  the D.2 corrective spec. **Deferred** under Strategy B: it needs a gateway
  that doc 11 does not build. Parked as a tracked spec, not dead code.
- [epic-56-unified-orchestration-runtime.md](../../_bmad-output/planning-artifacts/epic-56-unified-orchestration-runtime.md)
  the original four-pillar intent.
- [08-Transport-Architecture.md](./08-Transport-Architecture.md) the transport
  layer the gateway wraps (unchanged by the contract).
