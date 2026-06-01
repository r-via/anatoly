# 19. Run-Artifact Layout Convention (finalize doc 14/15)

> Status: PR 1 + PR 2 done (b831686, `src/utils/run-layout.ts` + writer
> migration). PR 3 (harness-assigned conversation dump names) and PR 4
> (enforcement golden + lint guard) open. Scope: finish the
> standardization doc 14 promised and doc 15 partially specified.
> Sibling of doc 14 (sink convention), doc 15 (observability), doc 18
> (doc-conflict cleanup). Non-behavioral for the audit score except for
> one filename change (PR 3, conversation dumps).

## 1. The decision

> **One module derives every path under `<runDir>/`. Writers do not join
> their own paths into the run directory. The layout is enforced by a
> structural golden, not by convention alone.**

Today only the **root** of the run directory is standardized: every
caller routes through [`runPath()`](../../src/utils/anatoly-paths.ts#L65)
for `<project>/.anatoly/runs/<runId>/`. Below that root, every
subdirectory name and filename is hardcoded at the write site (reporter,
review-writer, llm-calls-sink, run-status, run-config, doc.ts,
report.ts, rag.ts, conversation-dump callers). There is no single point
of truth for "where does `report.md` live", "what is the cost ledger
called", or "how is a conversation dump named". That is the gap this
convention closes.

## 2. Why now

Three forces converged on this:

1. **Doc 14 §1 promised** "a harness and a structure that future
   implementations are forced through". Realized for the in-memory cost
   rollup ([orchestration/cost.ts](../../src/core/orchestration/cost.ts));
   not realized for artifact paths and names.
2. **Doc 15 §3 point 4 mandated** harness-assigned conversation dump
   names of the form `<unit-slug>__<unit-name>__<n>.md`, replacing the
   per-call-site `conversationPrefix`. Tracked as doc 15 PR 3, still
   unbuilt; the leak is visible in
   [doc-indexer.ts:353](../../src/rag/doc-indexer.ts#L353) and
   [nlp-summarizer.ts:116](../../src/rag/nlp-summarizer.ts#L116) where
   each call site hand-builds its own prefix string.
3. **External consumers** (anatoly-bench, attach view, doc 15
   observability tests) parse the run directory by hardcoded path. Any
   silent drift in a writer breaks them invisibly. A central layout
   plus a structural golden makes drift loud.

## 3. The contract

For every artifact written into `<runDir>/`:

1. **Single source of truth.** The path is returned by a function
   exported from `src/utils/run-layout.ts` (new). Writers import that
   function and use its return value; they do not `join(runDir, ...)`
   directly.
2. **Frozen vocabulary.** The set of subdirectory names
   (`costs/`, `reviews/`, `logs/`, `axes/`, `conversations/`,
   `structure-review/`, `coherence-review/`) and the set of top-level
   filenames (`report.md`, `public_report.md`, `run-status.json`,
   `run-metrics.json`, `run-config.json`, `anatoly.ndjson`,
   `doc-reference-section.md`) are exhaustively listed in the module.
   Adding one is a deliberate module edit, not a string typed at a
   call site.
3. **Safe basenames.** File-derived names go through `toOutputName()`
   ([utils/cache.ts](../../src/utils/cache.ts)) inside the module, not
   at the call site, so the convention owns the slug rule.
4. **Harness-assigned dump names.** Conversation dump names are
   assigned by the runUnit harness from the unit identity, not by the
   call site (doc 15 PR 3, finally realized here).
5. **No silent drift.** A structural golden runs a hermetic mini-audit
   and asserts the produced directory tree matches the layout module's
   declared paths. New writer added without going through the module
   fails the golden.

## 4. The layout module (shape)

`src/utils/run-layout.ts`:

```ts
import { join } from 'node:path';
import { toOutputName } from './cache.js';

/**
 * Frozen layout of a run directory. The only legitimate way to derive
 * a path under `<runDir>/`. Writers import this and use the returned
 * object; they MUST NOT join into `runDir` directly.
 */
export function runLayout(runDir: string) {
  const reviewsDir = join(runDir, 'reviews');
  const logsDir = join(runDir, 'logs');
  const axesDir = join(runDir, 'axes');
  const costsDir = join(runDir, 'costs');
  const conversationsDir = join(runDir, 'conversations');
  return {
    // top-level files
    report:               join(runDir, 'report.md'),
    publicReport:         join(runDir, 'public_report.md'),
    status:               join(runDir, 'run-status.json'),
    metrics:              join(runDir, 'run-metrics.json'),
    config:               join(runDir, 'run-config.json'),
    events:               join(runDir, 'anatoly.ndjson'),
    docReferenceSection:  join(runDir, 'doc-reference-section.md'),
    // costs/
    costs: {
      dir:      costsDir,
      ledger:   join(costsDir, 'ledger.ndjson'),
      summary:  join(costsDir, 'summary.json'),
      variance: join(costsDir, 'variance.json'),
    },
    // reviews/
    reviews: {
      dir:  reviewsDir,
      json: (filePath: string) => join(reviewsDir, `${toOutputName(filePath)}.rev.json`),
      md:   (filePath: string) => join(reviewsDir, `${toOutputName(filePath)}.rev.md`),
    },
    // logs/
    logs: {
      dir:        logsDir,
      // per-source-file transcript (review/correction/etc.)
      transcript: (filePath: string) => join(logsDir, `${toOutputName(filePath)}.log`),
      // named non-file logs (rag-index.log, ...). Whitelisted in the
      // module to keep the vocabulary closed.
      named:      (name: 'rag-index' | string) => join(logsDir, `${name}.log`),
    },
    // axes/
    axes: {
      dir:       axesDir,
      axisDir:   (axis: string) => join(axesDir, axis),
      axisIndex: (axis: string) => join(axesDir, axis, 'index.md'),
      shard:     (axis: string, n: number) => join(axesDir, axis, `shard.${n}.md`),
    },
    // conversations/  (doc 15 PR 3: harness-assigned name)
    conversations: {
      dir:  conversationsDir,
      // The harness builds the name from the unit identity it owns,
      // expressed as the 4-segment slug already tracked by the
      // ALS log-context (phase / composer / primitive / callId) +
      // the per-call attempt number. Callers MUST NOT pass a
      // hand-built prefix anymore.
      dump: (slug: string, attempt: number) =>
        join(conversationsDir, `${slug}__${attempt}.md`),
    },
    // structure-review/ and coherence-review/ (doc bootstrap sub-logs)
    structureReview: (subpath?: string) =>
      subpath ? join(runDir, 'structure-review', subpath) : join(runDir, 'structure-review'),
    coherenceReview: (subpath?: string) =>
      subpath ? join(runDir, 'coherence-review', subpath) : join(runDir, 'coherence-review'),
  };
}

export type RunLayout = ReturnType<typeof runLayout>;
```

This is a pure path-deriver. No I/O. No mkdir. Writers still call
`mkdirSync(dir, { recursive: true })` on the directory paths the module
returns (the module decides *where*, not *whether*).

## 5. Per-writer migration table

Every site below stops typing `'reviews'`, `'costs'`, etc., and instead
calls `runLayout(runDir).<...>`. Byte-identical paths.

| Artifact | Current writer (file:line) | Becomes |
|---|---|---|
| `report.md` | [reporter.ts:2370](../../src/core/reporting/reporter.ts#L2370) | `runLayout(runDir).report` |
| `public_report.md` | [reporter.ts:2376](../../src/core/reporting/reporter.ts#L2376) | `runLayout(runDir).publicReport` |
| `axes/<axis>/index.md` and `shard.N.md` | [reporter.ts:2381](../../src/core/reporting/reporter.ts#L2381) | `runLayout(runDir).axes.{axisIndex,shard}` |
| `reviews/<f>.rev.{json,md}` | [review-writer.ts:19](../../src/core/reporting/review-writer.ts#L19) | `runLayout(runDir).reviews.{json,md}(file)` |
| per-file `logs/<f>.log` | [review-writer.ts:50](../../src/core/reporting/review-writer.ts#L50) | `runLayout(runDir).logs.transcript(file)` |
| `logs/rag-index.log` | [rag.ts:180](../../src/core/orchestration/phases/rag.ts#L180) | `runLayout(runDir).logs.named('rag-index')` |
| `run-status.json` | [run-status.ts:35](../../src/core/run/run-status.ts#L35) | `runLayout(runDir).status` |
| `run-config.json` | [run-config.ts](../../src/core/run/run-config.ts) (write site) | `runLayout(runDir).config` |
| `run-metrics.json` | [report.ts:381](../../src/core/orchestration/phases/report.ts#L381) | `runLayout(runDir).metrics` |
| `doc-reference-section.md` | [report.ts:141](../../src/core/orchestration/phases/report.ts#L141) | `runLayout(runDir).docReferenceSection` |
| `costs/ledger.ndjson` | [llm-calls-sink.ts:317](../../src/utils/llm-calls-sink.ts#L317), pipeline entry [pipeline.ts:133](../../src/core/orchestration/pipeline.ts#L133) | `runLayout(runDir).costs.ledger` |
| `costs/summary.json` | [llm-calls-sink.ts:316](../../src/utils/llm-calls-sink.ts#L316) | `runLayout(runDir).costs.summary` |
| `costs/variance.json` | [llm-calls-sink.ts:373](../../src/utils/llm-calls-sink.ts#L373) | `runLayout(runDir).costs.variance` |
| `anatoly.ndjson` | run logger init (in `utils/run-id.ts` / logger setup) | `runLayout(runDir).events` |
| `structure-review/...` | [doc.ts:184](../../src/core/orchestration/phases/doc.ts#L184) | `runLayout(runDir).structureReview(sub)` |
| `coherence-review/...` | [doc.ts:230](../../src/core/orchestration/phases/doc.ts#L230) | `runLayout(runDir).coherenceReview(sub)` |
| `conversations/<prefix>__<n>.md` | [conversation-dump.ts:45](../../src/core/transports/conversation-dump.ts#L45), callers in [doc-indexer.ts:353](../../src/rag/doc-indexer.ts#L353), [nlp-summarizer.ts:116](../../src/rag/nlp-summarizer.ts#L116), each axis transport call | `runLayout(runDir).conversations.dump(slug, attempt)`, where `slug = buildDumpSlug()` is read from the ALS log-context (`{phase}__{composer}__{primitive}__{callId}`) by the transport, NOT supplied at the call site |

## 6. Acceptance invariants (testable)

1. **Single deriver.** `runLayout` is the only function in `src/`
   exporting paths that contain a `runId`-rooted segment beyond the
   project root. (Audit by ESLint custom rule or by grep in CI:
   `grep -rn "join(.*runDir" src/ | grep -v 'run-layout.ts'` returns
   only writer call sites that use `runLayout(...)`.) Open question:
   ESLint vs grep CI step (low cost either way; pick one).
2. **Frozen golden.** A hermetic mini-audit produces a directory tree
   that matches a checked-in snapshot listing every artifact and its
   path. A new writer adding an unlisted file fails the snapshot.
3. **No hand-built dump prefixes.** Grep of `src/` outside
   `src/core/transports/` and `src/utils/run-layout.ts` for
   `conversationPrefix` returns zero matches.
4. **Byte-identical migration.** PRs 1 and 2 (module + migration) leave
   every artifact path byte-identical. The structural golden, computed
   at the tip of each migration PR, matches the pre-PR baseline.
5. **PR 3 is the only filename change.** Conversation dump names move
   from the current ad-hoc `<handcrafted-prefix>__<attempt>.md` (e.g.
   `rag__doc-chunk__<slug>__1.md`) to the 4-segment harness slug
   `{phase}__{composer}__{primitive}__{callId}__{attempt}.md` produced
   by [`buildDumpSlug()`](../../src/core/transports/conversation-dump.ts#L16)
   from the active ALS log-context. The transport reads the slug from
   the context; no call site passes a `conversationPrefix` anymore.
   Goldens that reference dump filenames are updated in the same PR;
   nothing else changes on disk.

## 7. PR sequence (ascending risk)

- **PR 1. Introduce the module.** New `src/utils/run-layout.ts` with the
  shape above. No callers. Tests cover every property (the layout is
  the unit under test, against a fixed `runDir = '/tmp/x'`). Zero
  behavior change.
- **PR 2. Migrate writers, byte-identical.** Per-category sub-PRs
  (2a costs, 2b reviews + logs, 2c axes + report, 2d run-status /
  -metrics / -config / events / doc-reference, 2e structure /
  coherence review). Each is gate-green and produces a structural
  golden diff of zero against the prior tip.
- **PR 3. Harness-assigned conversation dump names.** Kill per-call-site
  `conversationPrefix` (and the parallel `conversationFileSlug` axis
  context field). The harness owns the dump name as the 4-segment ALS
  log-context slug `{phase}__{composer}__{primitive}__{callId}` produced
  by [`buildDumpSlug()`](../../src/core/transports/conversation-dump.ts#L16);
  transports call the helper themselves at dump time. Each non-axis
  call site (RAG doc-indexer, RAG nlp-summarizer, doc-conflict pair
  verification, doc scaffolding, refinement tier-3 shards) tightens
  its `runWithContext({ composer, primitive, callId })` scope so the
  slug is well-formed at dump time. Updates goldens and any test
  asserting a dump filename. This is the **only behavior-relevant PR**
  (filenames in `conversations/` change). Doc 15 §3 point 4 closed.
- **PR 4. Enforcement.** Add the structural golden test (hermetic) and
  the ESLint or grep CI guard from §6 invariant 1. New writers that
  bypass the module fail CI loudly.

Each PR is independently shippable. PR 1 is mechanically safe; PRs 2a
to 2e are mechanical refactors; PR 3 is the one filename-changing PR
and must be reviewed for its updated goldens; PR 4 turns the
convention into a hard rail.

## 8. Risks

- **Risk: PR 3 breaks external consumers** that grep
  `conversations/rag__*` or `conversations/correction__*` by current
  ad-hoc prefix. Mitigation: audit anatoly-bench and the attach view
  before PR 3; update those consumers in the same release.
- **Risk: a writer is missed in PR 2** and keeps hardcoding. Mitigation:
  PR 4's ESLint/grep guard fails CI on any `join(.*runDir...)` outside
  `run-layout.ts`. PR 4 must therefore land in the same release as the
  last migration sub-PR (no window where the rail is off).
- **Risk: the layout vocabulary needs to grow** (new artifact). That is
  the intended escape valve: edit the module, add to the golden, ship.
  The convention's value is that the change is deliberate, not silent.

## 9. Non-goals

- **No scoped-writer / frozen-view machinery.** Doc 14 PR 6 declined
  that explicitly as speculative. The single deriver plus the
  structural golden plus the lint guard give the same forced-funnel
  property without the runtime cost or the dependency-injection
  rewiring.
- **No change to `runPath()`.** The existing helper stays; `runLayout`
  is the layer **below** it (it consumes the run-dir string `runPath`
  produced).
- **No change to in-memory cost rollup.** That is already standardized
  by `orchestration/cost.ts` (doc 14 §9 invariant 1) and is out of
  scope here; this convention is about on-disk artifacts.

## 10. Standalone-command observability (`commands/`)

`runs/` is reserved for audit runs. Standalone commands that make LLM
calls outside a run (today `docs arbitrate refresh` and `init --scope`,
more later) still produce observability: timestamped directories of
conversation transcripts. These were first written to a top-level
`.anatoly/refresh/` namespace, a sibling of `runs/`, which does not
scale: every new such command would add another top-level dir.

The convention groups them under a single namespace, one sub-directory
per command:

```
.anatoly/commands/<command>/<timestamp>/conversations/<dump>.md
                  refresh/2026-05-29T.../conversations/...
                  scope/2026-05-30T.../conversations/...
```

Rules:

1. **Single helper.** `commandPath(root, command, ...rest)` in
   [anatoly-paths.ts](../../src/utils/anatoly-paths.ts) is the only way
   to resolve a path here, exactly as `runPath` is for runs. `commands`
   is the one top-level area in `AnatolyArea`; the command name is an
   argument, not a frozen union member (commands are open-ended).
2. **Not a cache, not a run.** These are forensic, non-reproducible
   (rerunning never reproduces a transcript, nothing is read back by
   key). They are kept out of `cache/` (which `cache snapshot/restore/
   prune` would mishandle) and out of `runs/` (audits only).
3. **Bounded retention.** Each command prunes its own
   `commands/<command>/` to the newest N timestamped dirs via
   `pruneTimestampedRuns` ([command-retention.ts](../../src/utils/command-retention.ts)),
   best-effort, never failing the command.
4. **Migration.** Pre-existing `.anatoly/refresh/` trees are left in
   place (disposable forensic output); no data move. New writes land
   under `commands/refresh/`.
