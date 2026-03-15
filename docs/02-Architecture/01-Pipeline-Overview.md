# Pipeline Overview

Anatoly executes an 8-phase pipeline that transforms a TypeScript codebase into a structured audit report. Each phase feeds its output into the next, and the pipeline supports resumability through persistent progress tracking.

## The 8 Phases

```
 +-------+     +----------+     +--------+     +-------------+
 | Scan  | --> | Estimate  | --> | Triage | --> | Usage Graph |
 +-------+     +----------+     +--------+     +-------------+
                                                      |
                                                      v
 +-------+     +--------+     +---------------------+     +-------+
 | Badge | <-- | Report | <-- | Review+Deliberation | <-- | Index |
 +-------+     +--------+     +---------------------+     +-------+
```

### 1. Scan

Walks the project directory and discovers all TypeScript/JavaScript files matching the configured include/exclude globs. Produces a list of files with metadata (size, hash) and persists the result to `.anatoly/`. Files whose content hash has not changed since the previous run are marked as cached.

- **Input:** project root, config globs
- **Output:** file list with hashes, cache status (new vs cached)
- **Cost:** zero (local I/O only)

### 2. Estimate

Loads the task list produced by the scanner and computes token estimates for the entire review. Calculates input/output token counts, symbol counts, and a time estimate factoring in the configured concurrency level.

- **Input:** task list from scan
- **Output:** token budget, time estimate, file count
- **Cost:** zero (local computation)

### 3. Triage

Classifies each file into one of two tiers: **skip** or **evaluate**. Files that are trivial (auto-generated, configuration-only, very small) receive a synthetic review without any API call. Files that need substantive review proceed to the evaluate tier.

- **Input:** task list, file source code
- **Output:** `Map<filePath, TriageResult>` with tier and reason
- **Cost:** zero (heuristic-based, no LLM calls)
- **Effect:** reduces the number of files sent to the Review phase, cutting both cost and wall-clock time

### 4. Usage Graph

Builds a pre-computed import resolution graph by scanning every file's import/export statements using regex-based extraction. The graph maps each exported symbol to the set of files that import it (distinguishing runtime imports from type-only imports).

- **Input:** task list, project source files
- **Output:** `UsageGraph` with `usages` and `typeOnlyUsages` maps, keyed by `"symbolName::filePath"`
- **Cost:** zero (local I/O + regex, no API calls)
- **Effect:** provides ground-truth import data to the utility axis, eliminating the need for the LLM to guess whether a symbol is used

### 5. Index (RAG)

Builds a local vector index of all function/method/hook symbols in the project. For each function, Anatoly constructs a `FunctionCard` from AST-derived data (signature, complexity score, called internals) and embeds the function's source code using a local transformer model (`jinaai/jina-embeddings-v2-base-code`, 768 dimensions). Embeddings are stored in a LanceDB vector database at `.anatoly/rag/lancedb/`.

- **Input:** task list, project source files
- **Output:** `VectorStore` with indexed FunctionCards, stale entries garbage-collected
- **Cost:** zero API cost (all embeddings computed locally via `@xenova/transformers`)
- **Caching:** a file-hash-keyed cache (`.anatoly/rag/cache.json`) skips re-indexing unchanged functions

### 6. Review + Deliberation

The core evaluation phase. Each file in the evaluate tier is processed through all enabled axis evaluators running in parallel via `Promise.allSettled`. A configurable worker pool (1-10 concurrency) processes files concurrently. Each axis evaluator makes a single-turn LLM call with a Zod-validated JSON response. Results from all axes are merged into a single `ReviewFile` (version 2).

After merging, an optional deliberation sub-pass using a stronger model (typically Claude Opus) validates the results. Deliberation is only triggered for files with findings (NEEDS_FIX, ERROR, DEAD, DUPLICATE, OVER) or files with low-confidence results. The deliberation judge verifies inter-axis coherence, filters false positives, and can reclassify symbols. ERROR findings are protected and require 95%+ confidence to downgrade.

- **Input:** file content, task metadata, usage graph, RAG vector store, dependency metadata, project tree
- **Output:** per-file `ReviewFile` with symbol-level verdicts, actions, and best-practices scores (optionally refined by deliberation)
- **Cost:** LLM API calls (axis evaluators + optional deliberation Opus call per qualifying file)
- **Crash isolation:** if one axis evaluator fails, the remaining axes still produce results; the failed axis falls back to safe defaults

### 7. Report

Aggregates all per-file reviews into a project-level report. Computes global statistics (total files, findings, clean files), generates the Markdown report, and writes run metrics to `run-metrics.json`.

- **Input:** all `ReviewFile` outputs, triage stats, run context
- **Output:** Markdown report, run metrics JSON
- **Cost:** zero (local I/O only)

### 8. Badge Injection

Optionally injects or updates a shield badge in the project's `README.md` reflecting the global audit verdict. Controlled by `--no-badge` flag or `badge.enabled` config.

- **Input:** global verdict from report phase, README.md
- **Output:** updated README.md with audit badge
- **Cost:** zero (local I/O only)

## Data Flow Summary

```
Scan
 |-- file list + hashes
 v
Estimate
 |-- token/time estimates
 v
Triage
 |-- skip/evaluate classification per file
 v
Usage Graph
 |-- symbol -> importer mapping
 v
Index (RAG)
 |-- FunctionCard vector store
 v
Review + Deliberation (per file, concurrent)
 |-- axis evaluators (parallel via Promise.allSettled)
 |-- axis results merged into ReviewFile v2
 |-- optional Opus deliberation (validation, reclassification)
 v
Report
 |-- Markdown report, run-metrics.json
 v
Badge Injection
 |-- README.md badge update (optional)
```

## Resumability and Caching

Anatoly tracks progress at multiple levels:

- **Scan cache:** files whose content hash has not changed are marked as cached, avoiding redundant processing.
- **RAG cache:** `.anatoly/rag/cache.json` maps each `functionId` to the file hash at the time of indexing. Functions in unchanged files are not re-embedded.
- **Progress manager:** tracks per-file review status (PENDING, IN_PROGRESS, DONE, CACHED, ERROR, TIMEOUT). If a run is interrupted (SIGINT), completed reviews are preserved. A subsequent run picks up where the previous one left off.
- **Run isolation:** each run gets a unique `runId` and its own directory under `.anatoly/runs/<runId>/` containing reviews, transcripts, logs, and metrics. Old runs are purged based on `output.max_runs` configuration.
- **Lock file:** a project-level lock prevents concurrent runs from corrupting shared state.

The `--no-cache` flag forces re-review of all cached files. The `--file <glob>` flag scopes a run to specific files, implicitly bypassing the cache for matched files. The `--rebuild-rag` flag drops and recreates the entire vector index.
