# Anatoly Technical Architecture

Anatoly is a deep audit agent for TypeScript codebases. It performs automated, multi-axis code review by orchestrating parallel LLM evaluations against every symbol in a project, then merging and reporting results.

This document describes the system architecture, pipeline phases, component interactions, state management, error handling, and concurrency model.

---

## High-Level System Diagram

```
                           CLI (Commander.js)
                                 |
              .------------------+-------------------.
              |       anatoly run  (full pipeline)    |
              '------------------+-------------------'
                                 |
       +---------------------------------------------------------+
       |                   Run Orchestrator                      |
       |                  (src/commands/run.ts)                  |
       +---------------------------------------------------------+
                                 |
       Phase 1    Phase 2    Phase 3    Phase 4    Phase 5
       -------    -------    -------    -------    -------
        Scan     Estimate    Triage    Usage      RAG
       (AST)    (tiktoken)  (classify)  Graph      Index
                                 |
       Phase 6                Phase 7                Phase 8
       -------                -------                -------
        Review                 Report                 Badge
       (worker pool)          (sharded MD)           Injection
           |
           +--- file-evaluator.ts ------+
           |                            |
      +----+----+----+----+----+----+   |
      | Ax1| Ax2| Ax3| Ax4| Ax5| Ax6|  |  (Promise.allSettled per file)
      +----+----+----+----+----+----+   |
           |                            |
           +--- axis-merger.ts ---------+
           |
           +--- deliberation.ts --------+  (optional Opus pass)
           |
      .rev.json / .rev.md / transcript
```

---

## The 8-Phase Pipeline

The `anatoly run` command executes a deterministic pipeline of 8 sequential phases. Each phase feeds its output into subsequent phases. The pipeline is orchestrated by `runSetupPhase`, `runRagPhase`, `runReviewPhase`, and `runReportPhase` in `src/commands/run.ts`.

### Phase 1: Scan

**Module:** `src/core/scanner.ts`

Discovers all TypeScript files matching the configured `scan.include` / `scan.exclude` globs, filtered against `.gitignore`. For each file:

1. Computes a SHA-256 content hash.
2. Parses the AST via **tree-sitter** (WASM bindings for TypeScript/TSX).
3. Extracts top-level symbols: functions, classes, types, enums, methods, hooks, constants, variables.
4. Writes a `.task.json` file per source file into `.anatoly/tasks/`.
5. Updates `progress.json` with per-file status (PENDING, CACHED, DONE).

Files whose hash matches a previous scan are marked CACHED and skip re-parsing. Istanbul/Vitest/Jest coverage data is optionally attached to each task when `coverage.enabled` is true.

**Output:** `.anatoly/tasks/*.task.json`, `.anatoly/cache/progress.json`

### Phase 2: Estimate

**Module:** `src/core/estimator.ts`

Loads all `.task.json` files and computes cost/time estimates:

- **Input tokens:** measured via `tiktoken` (cl100k_base encoding) on actual file content, plus system prompt overhead (600 tokens) and per-file overhead (50 tokens).
- **Output tokens:** estimated from symbol count (150 tokens/symbol + 300 base/file).
- **Time:** weighted formula: `BASE_SECONDS (4s) + SECONDS_PER_SYMBOL (0.8s) * symbolCount`, adjusted by a concurrency efficiency factor of 0.75.

This is a purely local computation with zero API calls.

**Output:** Display-only (token counts, estimated minutes).

### Phase 3: Triage

**Module:** `src/core/triage.ts`

Classifies every file into one of two tiers:

| Tier | Condition | API Cost |
|------|-----------|----------|
| **skip** | Barrel exports, trivial files (<10 lines, <=1 symbol), type-only files, constants-only files | Zero (synthetic CLEAN review generated) |
| **evaluate** | Everything else (internal, simple, complex) | Full axis evaluation |

Skip-tier files receive a synthetic `ReviewFile` with `is_generated: true` and all symbols marked as clean defaults. This avoids wasting API calls on files that cannot produce meaningful findings.

The triage phase also recalculates the time/token estimate scoped to evaluate-tier files only, providing a more accurate ETA.

**Output:** `Map<string, TriageResult>` (in-memory, passed to review phase).

### Phase 4: Usage Graph

**Module:** `src/core/usage-graph.ts`

Builds a project-wide import/export graph by regex-scanning all source files for:

- Named imports/exports: `import { A, B } from './path'`
- Default imports: `import X from './path'`
- Namespace imports: `import * as X from './path'`
- Re-exports: `export { A } from './path'`, `export * from './path'`
- Type-only imports: `import type { A } from './path'` (tracked separately)

Import specifiers are resolved to project-relative file paths with `.js` -> `.ts` extension mapping and `index.ts` directory resolution.

The graph maps `"symbolName::filePath"` to the set of files that import that symbol. Runtime and type-only imports are tracked in separate maps. This data feeds the **utility axis** evaluator, enabling it to detect dead exports (exported but imported by zero files) and orphan symbols.

Also builds a project tree string (`buildProjectTree`) used as context in evaluator prompts.

**Output:** `UsageGraph` + `projectTree` (in-memory, passed to review phase).

### Phase 5: RAG Index

**Module:** `src/rag/orchestrator.ts`

Builds a semantic vector index for cross-file duplication detection:

1. Filters tasks to files with function/method/hook symbols.
2. Builds `FunctionCard` objects from AST symbol ranges (source code slicing).
3. Computes code embeddings locally (no LLM API calls) using `jinaai/jina-embeddings-v2-base-code` (768-dim, via `@xenova/transformers`).
4. Upserts cards and embeddings into the `VectorStore` (LanceDB).
5. Garbage-collects stale entries for files no longer in the project.
6. Uses a persistent cache (`.anatoly/rag/cache.json`) keyed by `functionId + fileHash` to avoid re-embedding unchanged functions.
7. Auto-detects dimension mismatches (e.g., after a model switch) and triggers a full rebuild.

The worker pool is reused here for concurrent embedding computation. Since embeddings are computed locally (no API calls), this phase is CPU-bound. Results are accumulated in memory and batch-upserted sequentially into the vector store after all workers complete.

**Output:** `VectorStore` instance (in-memory, passed to review phase).

### Phase 6: Review

**Module:** `src/core/file-evaluator.ts`, `src/core/axes/*.ts`, `src/core/axis-merger.ts`, `src/core/deliberation.ts`

This is the core of the audit. For each evaluate-tier file, the system:

1. **Reads the file** once and builds an `AxisContext` containing the source, task metadata, usage graph, RAG results, dependency metadata, and project tree.

2. **Pre-resolves RAG** by querying the vector store for each function symbol via `searchById`, producing similarity results for the duplication evaluator.

3. **Runs 6 axis evaluators in parallel** via `Promise.allSettled`:

   | Axis | Default Model | Ratings | Purpose |
   |------|--------------|---------|---------|
   | `utility` | haiku | USED / DEAD / LOW_VALUE | Detects dead or low-value code using the usage graph |
   | `duplication` | haiku | UNIQUE / DUPLICATE | Finds code clones via RAG vector similarity |
   | `correction` | sonnet | OK / NEEDS_FIX / ERROR | Finds bugs, logic errors, unsafe operations |
   | `overengineering` | haiku | LEAN / OVER / ACCEPTABLE | Flags unnecessary complexity |
   | `tests` | haiku | GOOD / WEAK / NONE | Assesses test coverage quality |
   | `best_practices` | sonnet | Score 0-10 (17 rules) | File-level TypeScript best practices |

   Each evaluator calls the Claude Code SDK (`@anthropic-ai/claude-agent-sdk`) via `runSingleTurnQuery` -- a single-turn, no-tools query with `allowedTools: []` and `permissionMode: 'bypassPermissions'`. The response is validated against a Zod schema with one automatic retry on validation failure (Zod error messages are fed back as context).

4. **Merges axis results** (`axis-merger.ts`) into a single `ReviewFile v2`:
   - Combines per-symbol results from each axis into a unified `SymbolReview`.
   - Applies inter-axis coherence rules:
     - `utility=DEAD` forces `tests=NONE` (no point testing dead code).
     - `correction=ERROR` forces `overengineering=ACCEPTABLE` (complexity is secondary to correctness).
   - Detects contradictions between correction and best_practices findings (e.g., async/error handling flagged by correction but passed by best_practices rule 12).
   - Computes file verdict: CLEAN / NEEDS_REFACTOR / CRITICAL based on high-confidence symbols (>=60).

5. **Deliberation pass** (optional, `deliberation.ts`): When enabled via `--deliberation` or `llm.deliberation` config, files with findings or low-confidence results are sent to an Opus-class model for a final validation pass:
   - Reviews the merged `ReviewFile` alongside the original source code.
   - Can reclassify NEEDS_FIX to OK (filtering false positives) with confidence >= 85.
   - Has a high bar (>=95 confidence) to downgrade ERROR findings ("ERROR protection").
   - Can remove invalidated actions.
   - Skipped for CLEAN files where all symbols have confidence >= 95.

6. **Writes outputs:**
   - `.rev.json` (structured review data) to `<runDir>/reviews/`
   - `.rev.md` (human-readable review) to `<runDir>/reviews/`
   - Streaming transcript log to `<runDir>/logs/`

Files are dispatched through a **worker pool** (see Concurrency Model below). Each file gets its own `AbortController` for cancellation on SIGINT. Failed evaluations are retried with exponential backoff (5 retries, 5s-120s delay).

**Output:** `<runDir>/reviews/*.rev.json`, `<runDir>/reviews/*.rev.md`, `<runDir>/logs/*.log`

### Phase 7: Report

**Module:** `src/core/reporter.ts`

Loads all `.rev.json` files from the run directory and generates a sharded Markdown report:

- **`report.md`** (index): Executive summary with finding counts by severity (high/medium/low across 4 categories: correction, utility, duplication, overengineering), shard links, error/degraded file lists, triage stats, and full methodology reference.
- **`report.N.md`** (shards): Up to 10 files per shard, sorted by severity (CRITICAL first). Each shard contains findings tables, symbol-level details, actions by category (quickwin/refactor/hygiene), and best practices suggestions.

Verdict computation:
- File verdicts are recomputed from symbols (not taken from the LLM): `ERROR` -> CRITICAL, any actionable finding with confidence >= 60 -> NEEDS_REFACTOR, otherwise CLEAN.
- The global verdict escalates: any CRITICAL file -> CRITICAL, any NEEDS_REFACTOR -> NEEDS_REFACTOR, otherwise CLEAN.
- Findings with confidence < 30 are discarded entirely; those < 60 are excluded from verdict computation but remain visible in review files.

Also writes `run-metrics.json` with per-phase timing, total cost, per-axis statistics (calls, duration, cost, tokens), error counts, and degraded review counts.

**Output:** `<runDir>/report.md`, `<runDir>/report.N.md`, `<runDir>/run-metrics.json`

### Phase 8: Badge Injection

**Module:** `src/core/badge.ts`

Post-report, optionally injects or updates a shield badge in the project's `README.md` reflecting the global audit verdict. Controlled by `--no-badge` flag or `badge.enabled` config. Can optionally include the verdict text via `--badge-verdict`.

---

## Component Interactions

```
src/
  cli.ts                    Command registration (Commander.js)
  commands/
    run.ts                  Pipeline orchestrator (phases 1-8)
    review-display.ts       Real-time progress rendering (per-axis spinner)
  core/
    scanner.ts              Phase 1: AST parsing (tree-sitter WASM)
    estimator.ts            Phase 2: Token/time estimation (tiktoken)
    triage.ts               Phase 3: Skip/evaluate classification
    usage-graph.ts          Phase 4: Import/export graph builder
    file-evaluator.ts       Phase 6: Per-file evaluation coordinator
    axis-evaluator.ts       SDK query engine (runSingleTurnQuery) + axis types
    axes/
      utility.ts            Haiku: dead code detection via usage graph
      duplication.ts        Haiku: code clone detection via RAG vectors
      correction.ts         Sonnet: bug/error detection
      overengineering.ts    Haiku: complexity analysis
      tests.ts              Haiku: test coverage assessment
      best-practices.ts     Sonnet: 17-rule TypeGuard v2 evaluation
      index.ts              Evaluator registry + config-driven filtering
    axis-merger.ts          Phase 6b: Merge 6 axis results + coherence rules
    deliberation.ts         Phase 6c: Optional Opus validation pass
    reporter.ts             Phase 7: Sharded Markdown report generation
    worker-pool.ts          Concurrency-limited async worker pool
    progress-manager.ts     Serialized progress state manager
    badge.ts                Phase 8: README badge injection
    project-tree.ts         Flat file tree for prompt context
    dependency-meta.ts      package.json dependency + README analysis
    review-writer.ts        .rev.json + .rev.md output formatting
  rag/
    orchestrator.ts         Phase 5: RAG indexing coordinator
    indexer.ts              Function card builder + embedding generation
    vector-store.ts         LanceDB wrapper (persistent vector index)
    embeddings.ts           Local code embedding model (Xenova)
  schemas/
    config.ts               .anatoly.yml Zod schema
    task.ts                 .task.json Zod schema
    review.ts               .rev.json Zod schema (ReviewFile v2)
    progress.ts             progress.json Zod schema
  utils/
    config-loader.ts        YAML config loader with defaults
    cache.ts                SHA-256 hashing + atomic JSON writes
    lock.ts                 PID-based lock file management
    run-id.ts               Run ID generation + directory management + purge
    rate-limiter.ts         Exponential backoff with jitter
    logger.ts               Structured logging (pino-compatible ndjson)
    log-context.ts          AsyncLocalStorage context propagation
    errors.ts               Typed error codes (AnatolyError)
```

### Data Flow Summary

```
Source Files (.ts/.tsx)
       |
       v
  [Scanner] ---> .task.json (AST symbols, SHA-256 hash, coverage)
       |
       v
  [Estimator] ---> display (token counts, ETA)
       |
       v
  [Triage] ---> skip/evaluate map
       |
       v
  [Usage Graph] ---> "symbol::file" -> Set<importers>  (in-memory)
       |
       v
  [RAG Index] ---> LanceDB vector store  (on disk)
       |
       v
  [Worker Pool] ---> dispatches evaluate-tier files
       |
       +---> [File Evaluator] (per file)
       |          |
       |          +---> RAG pre-resolution (vector similarity lookup)
       |          |
       |          +---> 6x [Axis Evaluator]  (Promise.allSettled)
       |          |          |
       |          |          +---> Claude SDK single-turn query
       |          |          +---> Zod validation (retry once on failure)
       |          |
       |          +---> [Axis Merger]  (coherence rules, verdict)
       |          |
       |          +---> [Deliberation]  (optional Opus pass)
       |          |
       |          +---> .rev.json + .rev.md + transcript
       |
       v
  [Reporter] ---> report.md + report.N.md + run-metrics.json
       |
       v
  [Badge] ---> README.md  (optional)
```

---

## State Management: `.anatoly/` Directory

All persistent state lives under the `.anatoly/` directory at the project root. This directory should be added to `.gitignore`.

```
.anatoly/
  anatoly.lock                          PID-based lock file (prevents concurrent runs)
  cache/
    progress.json                       Per-file review status tracking
  tasks/
    *.task.json                         One per source file (AST symbols, hash, coverage)
  correction-memory.json                Known false positives (persistent across runs)
  rag/
    cache.json                          Function ID -> file hash (embedding cache)
    lancedb/                            LanceDB vector store files
  runs/
    latest -> <runId>                   Symlink to most recent run
    <YYYY-MM-DD_HHmmss>/               One directory per audit run
      reviews/
        *.rev.json                      Structured review data (machine-readable)
        *.rev.md                        Human-readable review
      logs/
        *.log                           Per-file transcript (streamed during review)
      report.md                         Index report (summary + shard links)
      report.N.md                       Shard reports (up to 10 files each)
      run-metrics.json                  Timing, cost, per-axis stats, errors
      anatoly.ndjson                    Structured run log (debug-level ndjson)
```

### Key State Files

| File | Purpose | Written By | Read By |
|------|---------|------------|---------|
| `anatoly.lock` | Prevents concurrent instances via PID check | `lock.ts` | `lock.ts` |
| `progress.json` | Tracks per-file status (PENDING/IN_PROGRESS/DONE/CACHED/ERROR/TIMEOUT) | `scanner.ts`, `progress-manager.ts` | `progress-manager.ts`, `run.ts` |
| `*.task.json` | AST metadata per source file (symbols, hash, coverage) | `scanner.ts` | `estimator.ts`, `triage.ts`, `file-evaluator.ts`, `orchestrator.ts` |
| `rag/cache.json` | Embedding cache (avoids re-indexing unchanged functions) | `orchestrator.ts` | `orchestrator.ts` |
| `*.rev.json` | Structured review output (ReviewFile v2) | `review-writer.ts` | `reporter.ts` |
| `run-metrics.json` | Per-run performance data | `run.ts` | External tooling |

### Crash Recovery via `progress.json`

The progress file enables resumable runs:

- Files marked `DONE` or `CACHED` are skipped on re-run (unless `--no-cache` is passed).
- Files left as `IN_PROGRESS` (from a crash or SIGINT) are treated as pending and re-reviewed on the next run.
- Files marked `ERROR` or `TIMEOUT` are re-attempted on the next run.
- The `--file <glob>` flag force-resets matching files to PENDING regardless of their current status.

---

## Error Handling and Crash Resilience

### Typed Error System

All errors are wrapped in `AnatolyError` (defined in `src/utils/errors.ts`) with structured error codes:

| Error Code | Meaning | Retryable |
|-----------|---------|-----------|
| `LOCK_EXISTS` | Another instance is running | No |
| `SDK_ERROR` | Claude Code SDK failure (subprocess crash, exit code) | Yes |
| `SDK_TIMEOUT` | LLM request timed out | Yes |
| `ZOD_VALIDATION_FAILED` | LLM response did not match expected schema after 2 attempts | Yes |

Each `AnatolyError` carries a `retryable` flag, a machine-readable `code`, and a `formatForDisplay()` method for user-facing output.

### Retry with Exponential Backoff

The `retryWithBackoff` utility (`src/utils/rate-limiter.ts`) wraps each file evaluation:

- **Max retries:** 5
- **Base delay:** 5,000 ms
- **Max delay:** 120,000 ms
- **Jitter factor:** 0.2 (20% randomization to prevent thundering herd)

Only errors with `retryable: true` trigger retries. Non-retryable errors fail immediately. The retry loop respects the interruption flag and stops if SIGINT has been received.

### Axis-Level Fault Isolation

Each of the 6 axis evaluators runs independently via `Promise.allSettled` inside `file-evaluator.ts`. If one axis crashes:

- The remaining axes complete unaffected.
- The crashed axis ID is recorded in `failedAxes`.
- The axis merger applies safe defaults for the missing axis (e.g., `utility: 'USED'`, `correction: 'OK'`).
- The symbol detail includes a crash sentinel: `"*(axis crashed -- see transcript)*"`.
- The review is counted as "degraded" and flagged in the report.
- The transcript records the full error for debugging.

This means a single axis failure never prevents a file from receiving a review -- it reduces the review's coverage but does not block the pipeline.

### Zod Validation with LLM Feedback Retry

The `runSingleTurnQuery` function in `axis-evaluator.ts` implements a two-attempt validation loop:

1. Send prompt to LLM via Claude Code SDK.
2. Extract JSON from response (`extractJson` handles markdown fences, preamble text, etc.).
3. Validate against the axis-specific Zod schema.
4. On validation failure: send the Zod error messages back to the LLM in the same session (`persistSession: true`, `resume: sessionId`) and request corrected output.
5. Validate the second response. If it also fails, throw `ZOD_VALIDATION_FAILED`.

The system prompt explicitly instructs the model: no tools, no markdown fences, JSON-only response.

### SIGINT Handling

The run orchestrator installs a SIGINT handler with two-stage behavior:

1. **First SIGINT:** Sets `ctx.interrupted = true` and aborts all in-flight `AbortController` instances. The worker pool stops dispatching new items but waits for active workers to finish. A partial summary is printed showing files reviewed, findings, and in-flight abort count.
2. **Second SIGINT:** Force-exits the process (`process.exit(1)`) after flushing the file logger and releasing the lock.

### Lock File Protection

The `anatoly.lock` file (`src/utils/lock.ts`) prevents concurrent instances from corrupting shared state:

- Contains the PID and `started_at` timestamp as JSON.
- On acquisition, checks if the PID in an existing lock is still alive via `isProcessRunning()`.
- Stale locks (dead PIDs) are automatically cleaned up.
- Corrupted lock files are silently removed.
- Released in `finally` blocks and on SIGINT to handle crashes.
- The lock is acquired after setup (phases 1-4) and released after report generation, minimizing the locked window.

### Atomic Writes

All JSON state files (`progress.json`, `.task.json`, `.rev.json`) are written atomically via `atomicWriteJson` -- write to a temp file, then rename. This prevents corruption from mid-write crashes or SIGINT during a write.

### Per-Run Isolation

Each `anatoly run` creates a unique run directory (`.anatoly/runs/<runId>/`) with a timestamp-based ID (or user-provided `--run-id`). Reviews, transcripts, logs, and reports are scoped to the run directory, so a crashed or partial run does not pollute subsequent runs. Old runs are purged based on `output.max_runs` config.

A per-run ndjson log (`anatoly.ndjson`) captures debug-level structured events for post-mortem analysis.

---

## Concurrency Model

### Worker Pool Architecture

The core concurrency primitive is `runWorkerPool` (`src/core/worker-pool.ts`):

```
            runWorkerPool({ items, concurrency: N })
                          |
         +--------+-------+-------+--------+
         |        |       |       |        |
      Worker 0  Worker 1  ...  Worker N-1
         |        |       |       |
         v        v       v       v
       item[0]  item[1] item[2] item[3]  <-- initial dispatch
         |        |       |
         v        v       v
       item[4]  item[5] item[6]          <-- as workers free up
         ...
```

**Design:**

- Launches `min(concurrency, items.length)` async workers.
- Each worker loops: atomically grab the next item from a shared index (`nextIndex++`), execute the handler, repeat until no items remain.
- Workers are plain `async function` calls running concurrently via `Promise.all` -- no threads, no child processes. This leverages Node.js's single-threaded event loop where all LLM calls are I/O-bound (network requests to the Claude API).
- On interruption (`isInterrupted()` returns true), workers stop picking up new items but finish their current work. This is a graceful drain, not a hard abort.
- Errors in handlers are caught per-item (the handler is expected to handle its own errors); one failure does not stop other workers.
- Returns `{ completed, errored, skipped }` counts.

**Concurrency limits:**

- Configurable via `--concurrency <n>` (CLI) or `llm.concurrency` (config).
- Hard-capped at 1-10 (validated in `run.ts`).
- Time estimates apply a `CONCURRENCY_EFFICIENCY` factor of 0.75 (25% overhead for rate limits, API contention, and tail effects where the last workers finish alone).

### Parallelism Within a File

Inside each file evaluation (`file-evaluator.ts`), the 6 axis evaluators run in parallel via `Promise.allSettled`. This means:

| Worker Pool Concurrency | Axes per File | Max Concurrent LLM Requests |
|------------------------|---------------|----------------------------|
| 1 | 6 | 6 |
| 3 | 6 | 18 |
| 5 | 6 | 30 |
| 10 | 6 | 60 |

Each axis evaluator independently calls the Claude SDK. The 4 haiku-tier axes (utility, duplication, overengineering, tests) use a faster/cheaper model; the 2 sonnet-tier axes (correction, best_practices) use the primary model. Model selection is configurable per-axis via `llm.axes.<axis>.model`.

### Progress Serialization

The `ProgressManager` class uses an internal write queue (`Promise` chain) to serialize disk writes to `progress.json`. In-memory state updates are synchronous (single-threaded JS guarantee), while disk flushes are queued so concurrent callers (from different worker pool workers) never corrupt the file. A `flush()` method awaits all queued writes before the pipeline moves to the report phase.

### RAG Indexing Concurrency

The RAG phase reuses the same `runWorkerPool` for concurrent embedding computation. Since embeddings are computed locally (Xenova model, no API calls), this phase is CPU-bound. Results are accumulated in an array and batch-upserted sequentially into the vector store after all workers complete, followed by a single atomic cache write.

### Log Context Propagation

`AsyncLocalStorage` (`src/utils/log-context.ts`) propagates context (runId, phase, file, worker index, axis ID) through the async call stack. All log entries from `contextLogger()` automatically include the relevant context fields, enabling correlation of log entries across concurrent workers without explicit parameter threading.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ |
| Language | TypeScript (ESM, strict mode) |
| CLI | Commander.js |
| Build | tsup (esbuild) |
| Tests | Vitest |
| Lint | ESLint (flat config) |
| AST | web-tree-sitter (WASM) |
| Schema | Zod v4 |
| AI Agent | @anthropic-ai/claude-agent-sdk |
| Tokens | tiktoken (cl100k_base, local) |
| Watcher | chokidar v5 |
| Terminal | listr2 + chalk |
| Embeddings | jinaai/jina-embeddings-v2-base-code (768-dim, local via @xenova/transformers) |
| Vector Store | LanceDB (embedded, zero-server) |
| File Matching | picomatch + tinyglobby |

---

## Configuration

Anatoly is configured via `.anatoly.yml` at the project root. Key configuration sections:

| Section | Controls |
|---------|----------|
| `scan.include` / `scan.exclude` | File discovery globs |
| `llm.model` | Primary model for sonnet-tier axes (correction, best_practices) |
| `llm.fast_model` | Model for haiku-tier axes (utility, duplication, overengineering, tests) |
| `llm.deliberation_model` | Model for the Opus deliberation pass |
| `llm.concurrency` | Default worker pool size (1-10) |
| `llm.deliberation` | Enable/disable deliberation pass (default) |
| `llm.axes.<axis>.enabled` | Enable/disable individual axes |
| `llm.axes.<axis>.model` | Override model for a specific axis |
| `rag.enabled` | Enable/disable semantic RAG cross-file analysis |
| `coverage.enabled` | Enable/disable Istanbul coverage integration |
| `coverage.report_path` | Path to coverage-final.json |
| `badge.enabled` | Enable/disable README badge injection |
| `badge.verdict` | Include verdict text in badge |
| `badge.link` | Custom badge link URL |
| `output.max_runs` | Maximum retained run directories (auto-purge) |

---

## CLI Commands

| Command | Description | Pipeline Phases |
|---------|-------------|-----------------|
| `anatoly run` | Full audit pipeline | All 8 phases |
| `anatoly scan` | Scan only | Phase 1 |
| `anatoly estimate` | Scan + estimate | Phases 1-2 |
| `anatoly review` | Review pending files | Phase 6 only |
| `anatoly report` | Generate report from existing reviews | Phase 7 only |
| `anatoly status` | Show progress summary | Reads progress.json |
| `anatoly watch` | Watch mode (re-run on file changes) | All phases, looped |
| `anatoly rag-status` | Show RAG index statistics | Reads vector store |
| `anatoly clean-runs` | Purge old run directories | File cleanup |
| `anatoly reset` | Clear all state | Deletes .anatoly/ |
| `anatoly hook` | Git hook / Claude Code hook integration | Coordination |

### Global Flags

| Flag | Effect |
|------|--------|
| `--config <path>` | Custom config file path |
| `--verbose` | Detailed operation logs |
| `--no-cache` | Ignore SHA-256 cache, re-review all files |
| `--file <glob>` | Restrict scope to matching files |
| `--plain` | Disable listr2 interactive renderer |
| `--no-color` | Disable chalk colors |
| `--no-rag` | Disable RAG cross-file analysis |
| `--rebuild-rag` | Force full RAG re-indexation |
| `--open` | Open report in default app |
| `--concurrency <n>` | Worker pool size (1-10) |
| `--no-triage` | Disable triage, review all files |
| `--deliberation` / `--no-deliberation` | Toggle Opus deliberation pass |
| `--no-badge` | Skip README badge injection |
| `--badge-verdict` | Include verdict in badge |
| `--log-level <level>` | Set log level (fatal/error/warn/info/debug/trace) |
| `--log-file <path>` | Write logs to file in ndjson format |

---

See also: [How It Works](how-it-works.md) · [Analysis Axes](analysis-axes.md) · [Configuration](configuration.md) · [Logging](logging.md)
