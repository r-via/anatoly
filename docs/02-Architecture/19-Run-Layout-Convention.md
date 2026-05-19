# 19. Run-Layout Convention (artifact path centralization)

> Status: PR 1 done, PR 2 specced (deferred). Scope: standardize WHERE
> and how every artifact under `<project>/.anatoly/runs/<runId>/` is
> located and named, so a single module is the source of truth and a
> structural test prevents drift. Sibling of doc 14 (cost convention)
> and doc 15 (observability contract): doc 14 centralized cost
> accounting; doc 15 §3.4 named the missing "harness-assigned uniform
> conversation name" half (its PR 3); this doc generalizes both to the
> whole run-dir and folds doc 15 PR 3 in. Non-behavioral for the audit
> score; not a doc-16 lever. Cleanup + reliability + cloud-readiness.

## 1. Context

Doc 14 forced the cost chokepoint (orchestration/cost.ts; invariant 1:
no inline `recordLlmCost` in any phase or agent body) and standardized
the run-dir **root** through `runPath()`
([anatoly-paths.ts:65](../../src/utils/anatoly-paths.ts#L65)). The
subdir creation is also centralized
([run-id.ts:34](../../src/utils/run-id.ts#L34) creates `logs/`,
`reviews/`, `conversations/`).

What is NOT centralized is the **derivation of every artifact path
under the run-dir**. Today each writer hardcodes its own subdir name
and filename:

- `costs/ledger.ndjson`, `costs/summary.json`, `costs/variance.json`
  ([llm-calls-sink.ts:138,316,373](../../src/utils/llm-calls-sink.ts#L138))
- `axes/<axis>/index.md`, `axes/<axis>/shard.N.md`
  ([reporter.ts:2382-2391](../../src/core/reporting/reporter.ts#L2382))
- `report.md`, `public_report.md`
  ([reporter.ts:2371-2378](../../src/core/reporting/reporter.ts#L2371))
- `reviews/<name>.rev.json` / `.rev.md`
  ([review-writer.ts:19-37](../../src/core/reporting/review-writer.ts#L19))
- `logs/<name>.log`, `logs/rag-index.log`, `logs/doc-scaffold__<slug>.md`,
  `logs/summary.md`, `logs/coherence-review.md`
  ([review-writer.ts:50](../../src/core/reporting/review-writer.ts#L50),
  [rag.ts:180](../../src/core/orchestration/phases/rag.ts#L180),
  [doc-llm-executor.ts:176,460,946](../../src/core/documentation/generation/doc-llm-executor.ts#L176))
- `run-status.json`, `run-config.json`, `run-metrics.json`,
  `error.log`, `doc-reference-section.md`, `background.log`
  ([run-status.ts:35](../../src/core/run/run-status.ts#L35),
  [run-config.ts:106](../../src/core/run/run-config.ts#L106),
  [report.ts:357,141](../../src/core/orchestration/phases/report.ts#L141),
  [background-runner.ts:64,93](../../src/core/run/background-runner.ts#L64))
- `conversations/<prefix>__<n>.md` where `<prefix>` is hand-built per
  call site
  ([conversation-dump.ts:45](../../src/core/transports/conversation-dump.ts#L45);
  8+ distinct call sites build their own prefix strings such as
  `rag__doc-chunk__<slug>`, `rag__nlp-summary__<slug>`,
  `<file-slug>__<axis>`, `doc-conflict-detection__pairs-<n>`,
  `doc-gen-<timestamp>`, `tier3-shard-<timestamp>`)

Total: about 34 hardcoded path segments across 15+ files. No existing
test asserts the run-dir layout end-to-end (only `run-id.test.ts`
checks that the three startup subdirs exist).

Doc 15 already identified the conversation-naming half as PR 3 of its
sequence ("harness-assigned conversation dumps, kill per-call-site
`conversationPrefix`") and listed it as a binding invariant of its §5
("grep finds no hand-built `conversationPrefix` in unit bodies"). It
was not implemented. This doc generalizes that intent to the whole
run-dir layout: one module derives every path; a structural test makes
that the only legal way to derive one.

## 2. Why now

Three converging reasons, none of them an F1 lever:

1. **Reliability.** Every artifact location is a contract between the
   producer (writer) and the consumer (bench parser, reporter,
   background-runner, runs-list UX). Today that contract lives in 15+
   places. Two recent doc-16 PRs added new artifact code paths
   (doc-conflict ledger, pending-conflict surfacing) and each had to
   re-discover the convention. Centralizing it removes a recurring
   cost.
2. **Cloud roadmap (see [project_cloud_roadmap.md](../../memory/project_cloud_roadmap.md)).**
   External consumption needs a stable, declared artifact layout. A
   single path module is the natural place to publish that contract.
3. **Doc 15 PR 3 still open.** Without harness-assigned names, the
   "every unit LLM interaction yields exactly one harness-named
   conversation dump" invariant of doc 15 §5.4 cannot be enforced.
   This doc completes that half.

What this is NOT:

- Not a bench lever. The 5 non-doc correction misses
  (INV-WILD/FREESPIN/JACKPOT/ROUND/BETCAP, see
  [project_correction_axis_underdetection.md](../../memory/project_correction_axis_underdetection.md))
  are structurally outside this work.
- Not a relitigation of doc 14 PR 6 (which declined a speculative
  single-writer machinery). This is the **path-naming** seam, not a
  writer abstraction: writers keep calling `writeFileSync` directly;
  they just ask the central module for the path string.

## 3. The contract

For every artifact written under `<project>/.anatoly/runs/<runId>/`:

1. **Exactly one module derives its path.** New module
   `src/utils/run-layout.ts`. Every other module imports a named
   helper from it and never composes the path itself.
2. **Subdirectory names are constants** exported from the module
   (`logs`, `reviews`, `conversations`, `costs`, `axes`,
   `structure-review`, `coherence-review`). Writers reference the
   constants when they need a directory; they never inline the
   string.
3. **Special filenames are functions** (`reportPath`,
   `runStatusPath`, `costsLedgerPath`, `axisShardPath(axis, index)`,
   etc.) returning the absolute path. No writer concatenates
   `'report.md'`, `'run-status.json'`, `'ledger.ndjson'`, etc.
4. **Conversation dump names are harness-assigned**, not
   composed at the call site. The harness owns the slug derivation
   per doc 15 §3.4 (PR 2 below).
5. **A structural test fails the build** if any module outside
   `run-layout.ts` (or its tests) reintroduces a hardcoded run-dir
   path segment or filename from the published catalog. Allowlist for
   the module itself, its test, and doc-only references.

## 4. Acceptance invariants (testable)

1. `src/utils/run-layout.ts` exports a path helper for every artifact
   written under the run-dir; a fixture run produces a tree whose
   every entry is reachable from a published helper.
2. Outside `src/utils/run-layout.ts`, its test, and the migration
   targets, no source file under `src/` contains the literal strings
   `'costs/ledger.ndjson'`, `'costs/summary.json'`,
   `'costs/variance.json'`, `'run-status.json'`, `'run-config.json'`,
   `'run-metrics.json'`, `'public_report.md'`, `'rag-index.log'`,
   `'doc-reference-section.md'`, `'background.log'`,
   `'.rev.json'`, `'.rev.md'`. Asserted by a grep test.
3. No source file outside `src/utils/run-layout.ts` constructs a path
   by joining the run-dir with a hardcoded subdir name from the
   published list (`'logs'`, `'reviews'`, `'conversations'`,
   `'costs'`, `'axes'`, `'structure-review'`,
   `'coherence-review'`). Same grep test, narrower scope (only
   `join(runDir, '<name>'...)` form).
4. (PR 2 only) Every LLM interaction yields exactly one
   harness-named conversation dump matching
   `<unit-slug>__<unit-name>__<n>.md`; `grep` finds no
   `conversationPrefix:` literal in unit bodies (allowlist:
   transport plumbing + the harness assigner).
5. Bench F1 within run-to-run noise. PR 1 is byte-identical for
   paths (no name change); PR 2 changes conversation filenames only
   (goldens are run-id-scoped, conversations not asserted).

## 5. PR sequence

### PR 1 (this PR, mechanical, byte-identical paths)

Create `src/utils/run-layout.ts` and migrate every site listed in §1
to consume it. No path changes; only the call shape changes.

Module surface (final, exported names; signatures use
`(projectRoot: string, runId: string, ...)`):

```typescript
// Subdir names — single source of truth (constants)
export const RUN_SUBDIRS = {
  logs: 'logs',
  reviews: 'reviews',
  conversations: 'conversations',
  costs: 'costs',
  axes: 'axes',
  structureReview: 'structure-review',
  coherenceReview: 'coherence-review',
} as const;

// Subdir resolvers
export function logsDir(projectRoot, runId): string;
export function reviewsDir(projectRoot, runId): string;
export function conversationsDir(projectRoot, runId): string;
export function costsDir(projectRoot, runId): string;
export function axesDir(projectRoot, runId): string;
export function axisDir(projectRoot, runId, axis): string;
export function structureReviewDir(projectRoot, runId): string;
export function coherenceReviewDir(projectRoot, runId): string;

// Top-level files
export function reportPath(projectRoot, runId): string;        // report.md
export function publicReportPath(projectRoot, runId): string;  // public_report.md
export function runStatusPath(projectRoot, runId): string;     // run-status.json
export function runConfigPath(projectRoot, runId): string;     // run-config.json
export function runMetricsPath(projectRoot, runId): string;    // run-metrics.json
export function runErrorLogPath(projectRoot, runId): string;   // error.log
export function docReferenceSectionPath(projectRoot, runId): string;
export function runEventLogPath(projectRoot, runId): string;   // anatoly.ndjson (mini-run)
export function backgroundLogPath(projectRoot, runId): string; // background.log

// Costs
export function costsLedgerPath(projectRoot, runId): string;   // costs/ledger.ndjson
export function costsSummaryPath(projectRoot, runId): string;  // costs/summary.json
export function costsVariancePath(projectRoot, runId): string; // costs/variance.json

// Axes (axis name passed in; per-axis dir is created by reporter)
export function axisIndexPath(projectRoot, runId, axis): string;       // axes/<a>/index.md
export function axisShardPath(projectRoot, runId, axis, idx): string;  // axes/<a>/shard.<i>.md

// Reviews (filePath = audited source path; conversion via toOutputName)
export function reviewJsonPath(projectRoot, runId, filePath): string;  // reviews/<n>.rev.json
export function reviewMarkdownPath(projectRoot, runId, filePath): string;

// Logs
export function transcriptLogPath(projectRoot, runId, filePath): string; // logs/<n>.log
export function ragIndexLogPath(projectRoot, runId): string;             // logs/rag-index.log
export function docScaffoldLogPath(projectRoot, runId, slug): string;    // logs/doc-scaffold__<slug>.md
export function docGenSummaryLogPath(projectRoot, runId): string;        // logs/summary.md
export function docCoherenceReviewLogPath(projectRoot, runId): string;   // logs/coherence-review.md

// Conversations (PR 1 keeps the call shape; PR 2 changes the slug source)
export function conversationDumpPath(projectRoot, runId, slug, attempt): string;
```

All helpers delegate to `runPath()`
([anatoly-paths.ts:65](../../src/utils/anatoly-paths.ts#L65)) and the
existing `toOutputName()`
([cache.ts:40](../../src/utils/cache.ts#L40)) for filename derivation;
neither is duplicated. `RUN_SUBDIRS` is the only place a subdir name
appears.

Migration targets (full list, from the §1 inventory):

| Site | Current | After |
|---|---|---|
| [llm-calls-sink.ts:138](../../src/utils/llm-calls-sink.ts#L138) | `join(runDir, 'costs', 'ledger.ndjson')` | `costsLedgerPath(...)` |
| [llm-calls-sink.ts:316](../../src/utils/llm-calls-sink.ts#L316) | `join(runDir, 'costs', 'summary.json')` | `costsSummaryPath(...)` |
| [llm-calls-sink.ts:373](../../src/utils/llm-calls-sink.ts#L373) | `join(runDir, 'costs', 'variance.json')` | `costsVariancePath(...)` |
| [reporter.ts:2371](../../src/core/reporting/reporter.ts#L2371) | `'report.md'` | `reportPath(...)` |
| [reporter.ts:2377](../../src/core/reporting/reporter.ts#L2377) | `'public_report.md'` | `publicReportPath(...)` |
| [reporter.ts:2382](../../src/core/reporting/reporter.ts#L2382) | `axes/<a>/index.md` | `axisIndexPath(...)` |
| [reporter.ts:2389](../../src/core/reporting/reporter.ts#L2389) | `axes/<a>/shard.N.md` | `axisShardPath(...)` |
| [review-writer.ts:19-37](../../src/core/reporting/review-writer.ts#L19) | reviews/`.rev.json`/`.rev.md` | `reviewJsonPath`/`reviewMarkdownPath` |
| [review-writer.ts:50](../../src/core/reporting/review-writer.ts#L50) | `logs/<n>.log` | `transcriptLogPath(...)` |
| [run-status.ts:35](../../src/core/run/run-status.ts#L35) | `'run-status.json'` | `runStatusPath(...)` |
| [run-config.ts:106](../../src/core/run/run-config.ts#L106) | `'run-config.json'` | `runConfigPath(...)` |
| [report.ts:357](../../src/core/orchestration/phases/report.ts#L357) | `'run-metrics.json'` | `runMetricsPath(...)` |
| [report.ts:141](../../src/core/orchestration/phases/report.ts#L141) | `'doc-reference-section.md'` | `docReferenceSectionPath(...)` |
| [rag.ts:180](../../src/core/orchestration/phases/rag.ts#L180) | `'logs/rag-index.log'` | `ragIndexLogPath(...)` |
| [doc-llm-executor.ts:176](../../src/core/documentation/generation/doc-llm-executor.ts#L176) | `doc-scaffold__<slug>.md` | `docScaffoldLogPath(...)` |
| [doc-llm-executor.ts:460](../../src/core/documentation/generation/doc-llm-executor.ts#L460) | `'summary.md'` | `docGenSummaryLogPath(...)` |
| [doc-llm-executor.ts:946](../../src/core/documentation/generation/doc-llm-executor.ts#L946) | `'coherence-review.md'` | `docCoherenceReviewLogPath(...)` |
| [run.ts:768](../../src/commands/run.ts#L768) | `'error.log'` | `runErrorLogPath(...)` |
| [background-runner.ts:64](../../src/core/run/background-runner.ts#L64) | `'background.log'` | `backgroundLogPath(...)` |
| [background-runner.ts:93](../../src/core/run/background-runner.ts#L93) | `'error.log'` | `runErrorLogPath(...)` |
| [doc.ts:184,230](../../src/core/orchestration/phases/doc.ts#L184) | `runPath(..., 'structure-review')` | `structureReviewDir(...)` (and `coherence-review`) |
| [run-id.ts:38-40](../../src/utils/run-id.ts#L38) | `mkdirSync` of `logs`/`reviews`/`conversations` | `mkdirSync(logsDir(...))` etc. via `RUN_SUBDIRS` |
| [run-id.ts:76-77](../../src/utils/run-id.ts#L76) | `'anatoly.ndjson'`, `'conversations'` | `runEventLogPath(...)`, `conversationsDir(...)` |
| [conversation-dump.ts:45](../../src/core/transports/conversation-dump.ts#L45) | `join(dir, '<prefix>__<n>.md')` | `conversationDumpPath(...)` (PR 1 keeps slug param; PR 2 changes source) |

Then add the **structural enforcement test**
`src/utils/run-layout.test.ts`:

- Asserts the grep invariants of §4.2 and §4.3 on the live tree
  (read-only file walk under `src/`, ignore the module itself and any
  string inside `*.test.ts` that targets the module's own behavior).
- Asserts the module exports the named surface (regression guard).

Allowlist (concrete):

- `src/utils/run-layout.ts` (the module itself)
- `src/utils/run-layout.test.ts` (the test)
- `docs/02-Architecture/**` (documentation references)
- `src/utils/run-id.ts` for the three startup subdir names ONLY if
  rewritten to import `RUN_SUBDIRS`; once migrated, no allowlist
  entry needed there either.

Gate: typecheck + lint clean, full suite green, goldens unchanged
(paths are byte-identical). No bench (no audit-input change).

### PR 2 (deferred; doc 15 §6 PR 3 made concrete)

Kill per-call-site `conversationPrefix`. The harness assigns the
slug as `<unit-slug>__<unit-name>__<n>.md` (doc 15 §3.4). Concretely:

1. Extend `runUnit` / the single-turn query path with a
   `conversationName: { unitSlug, unitName }` carried through
   `HarnessCtx` (doc 14 §3.4 added the seam). The transport assembles
   the filename via `conversationDumpPath(...)` from the slug.
2. Remove `conversationPrefix` from the 8+ call sites enumerated in
   §1: axis evaluators, RAG doc-chunk / nlp-summary, doc-conflict
   detector, doc-gen orchestrator, refinement.
3. The structural test gains a third invariant: no
   `conversationPrefix:` string literal outside transport plumbing
   + the harness assigner.
4. Goldens: conversation filenames are not asserted (per-run,
   ephemeral). The conversation **count** is asserted in places it
   matters (cost.test.ts ledger row to dump match); the count is
   unchanged.

Behavior-relevant only in that conversation filenames change scheme
(`rag__doc-chunk__<slug>` becomes `rag-doc-chunk__<slug>__<n>` or
similar — name TBD when implemented). Gate: typecheck + lint + suite
+ conversation-naming test green; no bench needed (filename change
only, no audit input).

Why deferred: PR 2 is not mechanical. It touches 8+ unit bodies
across the LLM path, requires the `runUnit` to learn the
unit-name/slug seam (doc 14 left that pass-through), and changes
filenames which, while not asserted by goldens, do appear in
operator-visible places (a stable scheme is worth designing once
and not rushing). The right home for it is a small focused PR after
PR 1 lands.

## 6. What this does NOT cover

- The arbitration ledger at `<project>/.anatoly/state/doc-conflicts.yaml`
  is outside the run-dir; already centralized via `anatolyPath()`
  ([doc-conflict-store.ts:22](../../src/core/documentation/conflict/doc-conflict-store.ts#L22)).
  Not touched.
- The cache subtree at `<project>/.anatoly/cache/` (reviews,
  refinements, NLP summaries, RAG vectors). Already routed through
  `anatolyPath()`; structurally separate from the run-dir; not in
  scope here (covered by doc 14's `AnatolyArea` enum).
- No writer abstraction (doc 14 PR 6 stays declined). Writers still
  call `writeFileSync` directly. This doc only standardizes the
  **path** they pass to it.
- No bench lever. INV-WILD/FREESPIN/JACKPOT/ROUND/BETCAP are
  unaffected.

## 7. Ordering vs. open work

Independent of doc 16 (PR-3a fold fix vs. correction-axis lever) and
doc 18 (Items A/B). Can land at any time. Owner sequencing:

- PR 1 lands first (this work). Cheapest, zero-risk, unblocks
  doc 15 §5 invariant 4 from ever being enforceable.
- PR 2 follows when the conversation-naming scheme is designed
  (one short design pass + one PR).
- doc 16 / doc 18 continue independently.
