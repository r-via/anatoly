# Anatoly Source Tree Analysis

Annotated source tree for the Anatoly deep-audit agent. Each entry lists the file
path, a one-line description, and approximate line count. Test files (`*.test.ts`)
are grouped separately at the end.

Total source (non-test): ~9 600 LOC
Total test: ~7 100 LOC
Prompt templates: ~250 lines (Markdown)

---

## Entry Points

```
src/
├── index.ts              10 LOC   CLI entry point — creates Commander program and calls parse()
├── cli.ts                81 LOC   Defines the Commander program, registers all subcommands and global options
```

---

## Commands (`src/commands/`)

```
commands/
├── index.ts              11 LOC   Barrel re-export of all command registrations
├── run.ts               799 LOC   Full pipeline orchestrator: scan → estimate → triage → RAG index → review → report → badge
├── hook.ts              383 LOC   Claude Code PostToolUse hook: detects file writes, spawns background single-file reviews
├── watch.ts             239 LOC   Chokidar-based file watcher for incremental re-scan and re-review on save
├── review.ts            179 LOC   Standalone review command: evaluates all pending files with axis pipeline
├── reset.ts             148 LOC   Wipe .anatoly state (tasks, reviews, cache, RAG index) with interactive confirm
├── status.ts            101 LOC   Display current audit progress bar, file counts, run history, and findings summary
├── rag-status.ts         90 LOC   Inspect RAG vector store: card count, per-function lookup, JSON dump
├── report.ts             88 LOC   Generate or regenerate the Markdown audit report from completed reviews
├── review-display.ts     88 LOC   Terminal UI helpers: spinner animation, per-file axis progress, finding counters
├── clean-runs.ts         81 LOC   Delete old run directories from .anatoly/runs/ with optional --keep N
├── estimate.ts           42 LOC   Token and wall-time estimation via tiktoken (no LLM calls)
├── scan.ts               21 LOC   Parse AST with tree-sitter and compute SHA-256 hashes for all TypeScript files
```

---

## Core Engine (`src/core/`)

```
core/
├── reporter.ts          579 LOC   Aggregate reviews into a structured Markdown report with verdict, findings, and stats
├── axis-evaluator.ts    417 LOC   LLM query runner: wraps Claude Agent SDK, manages single-turn calls with Zod validation
├── scanner.ts           400 LOC   Tree-sitter AST parser: extracts symbols (functions, classes, types) and computes file hashes
├── dependency-meta.ts   297 LOC   Reads package.json dependencies, extracts per-file import context, loads README sections
├── usage-graph.ts       293 LOC   Static import analysis: builds a graph of which symbols are imported where (runtime vs type-only)
├── review-writer.ts     282 LOC   Writes .rev.json and .rev.md output for completed file reviews, plus transcript logs
├── axis-merger.ts       279 LOC   Merges per-axis evaluation results into a single ReviewFile with unified symbol verdicts
├── deliberation.ts      266 LOC   Optional Opus deliberation pass: re-examines merged results to reduce false positives
├── file-evaluator.ts    248 LOC   Per-file orchestrator: runs all enabled axis evaluators, merges, optionally deliberates
├── estimator.ts         189 LOC   Token counting (tiktoken) and wall-time estimation with concurrency efficiency model
├── project-tree.ts      184 LOC   Builds a compact ASCII tree visualization of scanned project files
├── triage.ts            114 LOC   Fast heuristic filter: classifies files as skip (barrel, type-only) or evaluate
├── correction-memory.ts 113 LOC   Persists known false-positive patterns to disk for correction axis learning
├── progress-manager.ts  110 LOC   Thread-safe read/write of file review progress (PENDING → IN_PROGRESS → DONE)
├── badge.ts              91 LOC   Injects/updates an "audited by Anatoly" badge into the project README
├── worker-pool.ts        68 LOC   Generic concurrency-limited async worker pool with interrupt support
```

---

## Axis Evaluators (`src/core/axes/`)

Each axis evaluator implements the `AxisEvaluator` interface, sends a single-turn
LLM query with a system prompt, and parses the structured JSON response via Zod.

```
core/axes/
├── index.ts              44 LOC   Registry of all axis evaluators; filters by config-enabled axes
├── correction.ts        421 LOC   Correctness axis: detects bugs, API misuse, logic errors; uses README sections + correction memory
├── duplication.ts       181 LOC   Duplication axis: identifies near-duplicate symbols across the codebase via RAG similarity
├── best-practices.ts    172 LOC   Best practices axis: file-level rule checks (17 rules) for TypeScript coding standards
├── utility.ts           124 LOC   Utility axis: classifies symbols as USED, DEAD, or LOW_VALUE using usage graph data
├── overengineering.ts   116 LOC   Overengineering axis: flags unnecessarily complex abstractions (LEAN / OVER / ACCEPTABLE)
├── tests.ts             115 LOC   Tests axis: evaluates test coverage quality per symbol (GOOD / WEAK / NONE)
```

### System Prompts (`src/core/axes/prompts/`)

```
core/axes/prompts/
├── best-practices.system.md   65 lines   Rules and response format for the best-practices evaluator
├── duplication.system.md      43 lines   Instructions for cross-file duplicate detection
├── correction.system.md       41 lines   Guidelines for correctness bug detection
├── utility.system.md          33 lines   Criteria for dead code and low-value symbol classification
├── tests.system.md            32 lines   Rubric for test coverage quality assessment
├── overengineering.system.md  32 lines   Heuristics for complexity and abstraction excess
```

---

## RAG Subsystem (`src/rag/`)

Semantic retrieval-augmented generation layer using local code embeddings and LanceDB.

```
rag/
├── vector-store.ts      299 LOC   LanceDB-backed vector store: upsert, similarity search, stats, file deletion
├── indexer.ts           195 LOC   Builds function cards from scanned tasks, computes embeddings, manages RAG cache
├── orchestrator.ts      190 LOC   Coordinates full project RAG indexation: diff detection, parallel embedding, store writes
├── embeddings.ts         51 LOC   Jina embeddings v2 (768-dim) via @xenova/transformers: embed(), buildEmbedCode()
├── types.ts              38 LOC   Zod schemas for FunctionCard, SimilarityResult, RagStats
├── index.ts               8 LOC   Barrel re-export of all RAG module symbols
```

---

## Schemas (`src/schemas/`)

Zod schemas defining the data contracts for tasks, reviews, configuration, and progress.

```
schemas/
├── review.ts            137 LOC   ReviewFile schema: per-symbol verdicts, actions, best-practices, file-level verdict
├── config.ts            122 LOC   .anatoly.yml config schema: scan globs, LLM settings, axis toggles, RAG options
├── task.ts               45 LOC   Task schema: scanned file metadata with symbols, coverage data, hash
├── progress.ts           28 LOC   Progress schema: per-file status tracking (PENDING/IN_PROGRESS/DONE/ERROR/CACHED)
```

---

## Utilities (`src/utils/`)

```
utils/
├── logger.ts            150 LOC   Pino-based structured logger with file output, pretty-print, and namespace support
├── run-id.ts            141 LOC   Run ID generation (timestamp), run directory management, symlink to latest, purge
├── rate-limiter.ts      120 LOC   Exponential backoff with jitter for retrying rate-limited API calls
├── hook-state.ts         86 LOC   Persists Claude Code hook session state: tracks in-flight background reviews
├── lock.ts               79 LOC   PID-based lock file to prevent concurrent Anatoly instances; stale lock cleanup
├── log-context.ts        79 LOC   AsyncLocalStorage-based log context: attaches runId, file, axis, worker to log entries
├── errors.ts             71 LOC   AnatolyError class with error codes and user-facing recovery hints
├── config-loader.ts      58 LOC   Loads and validates .anatoly.yml with YAML parsing and Zod schema defaults
├── format.ts             57 LOC   Terminal formatting: progress bars, verdict colorization, token count display
├── cache.ts              51 LOC   SHA-256 hashing, atomic JSON writes, progress file read, output name conversion
├── extract-json.ts       50 LOC   Extracts JSON from LLM responses: handles markdown fences and brace-nesting
├── git.ts                34 LOC   Git helpers: list tracked files, check .gitignore status
├── open.ts               30 LOC   Cross-platform file opener (xdg-open / open / start)
├── confirm.ts            27 LOC   Interactive y/N confirmation prompt for destructive operations
├── process.ts            13 LOC   Check if a PID is still running (used by lock and hook-state)
├── version.ts             3 LOC   Exports the package version injected at build time
```

---

## Types (`src/types/`)

```
types/
├── md.d.ts                4 LOC   TypeScript module declaration allowing .md file imports as strings
```

---

## Test Files

All test files follow the `*.test.ts` convention and are co-located with their source.

```
commands/
├── clean-runs.test.ts    51 LOC
├── hook.test.ts         106 LOC
├── reset.test.ts         66 LOC
├── run.test.ts           35 LOC

core/
├── axis-evaluator.test.ts    72 LOC
├── axis-merger.test.ts      307 LOC
├── badge.test.ts            187 LOC
├── deliberation.test.ts     411 LOC
├── dependency-meta.test.ts  271 LOC
├── estimator.test.ts        222 LOC
├── file-evaluator.test.ts   254 LOC
├── progress-manager.test.ts 123 LOC
├── project-tree.test.ts     132 LOC
├── reporter.test.ts         635 LOC
├── review-writer.test.ts    358 LOC
├── scanner.test.ts          372 LOC
├── triage.test.ts           213 LOC
├── usage-graph.test.ts      257 LOC
├── worker-pool.test.ts      146 LOC

core/axes/
├── best-practices.test.ts   145 LOC
├── correction.test.ts       156 LOC
├── duplication.test.ts      117 LOC
├── index.test.ts             59 LOC
├── overengineering.test.ts   57 LOC
├── tests.test.ts             80 LOC
├── utility.test.ts           82 LOC

rag/
├── indexer.test.ts          237 LOC
├── orchestrator.test.ts     252 LOC
├── vector-store.test.ts      46 LOC

schemas/
├── config.test.ts           116 LOC
├── progress.test.ts          51 LOC
├── review.test.ts           209 LOC

utils/
├── cache.test.ts             84 LOC
├── config-loader.test.ts     95 LOC
├── confirm.test.ts           79 LOC
├── errors.test.ts           122 LOC
├── format.test.ts            44 LOC
├── hook-state.test.ts       131 LOC
├── lock.test.ts             104 LOC
├── log-context.test.ts      111 LOC
├── logger.test.ts           155 LOC
├── open.test.ts              62 LOC
├── rate-limiter.test.ts     142 LOC
├── run-id.test.ts           146 LOC

src/
├── index.test.ts             49 LOC
```
