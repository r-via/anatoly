# Commands

Anatoly provides a pipeline-oriented CLI. The primary command is `run`, which orchestrates the full audit pipeline. Individual stages can also be invoked independently for debugging or incremental workflows.

All commands inherit the [global options](./02-Global-Options.md) defined on the root `anatoly` program.

---

## run

Execute the full audit pipeline: scan, estimate, triage, RAG index, review, and report.

```
anatoly run [--run-id <id>] [--axes <list>]
```

> **Incremental by default.** `anatoly run` only re-reviews files whose content has changed since the previous run (SHA-256 cache). Pass `--no-cache` to force a full re-review of the entire codebase.

### Options

| Flag | Type | Description |
|------|------|-------------|
| `--run-id <id>` | string | Custom run identifier. Must be alphanumeric with dashes and underscores. Defaults to an auto-generated timestamp-based ID. |
| `--axes <list>` | string | Comma-separated list of axes to evaluate (e.g. `correction,tests`). Only the listed axes run; others are skipped. Intersects with config-disabled axes. Omit to run all enabled axes. Valid axes: `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices`, `documentation`. The cache tracks which axes were evaluated per file: switching to a different `--axes` set invalidates the cache for files that were not previously evaluated on the requested axes. |

### Behavior

1. **Config** -- Loads `.anatoly.yml`, resolves concurrency, RAG, cache, and deliberation settings.
2. **Scan** -- Parses the AST and computes SHA-256 hashes for all TypeScript files matching the configured `scan.include` globs.
3. **Estimate** -- Counts symbols and estimates input/output tokens and wall-clock time via tiktoken (no LLM calls).
4. **Triage** -- Classifies files as `skip` (synthetic review, no API call) or `evaluate` (full agent review). Disable with `--no-triage`.
5. **Usage graph** -- Builds an import/export edge map used by the Utility axis.
6. **RAG index** -- Embeds function cards into a LanceDB vector store for cross-file duplication search. Disable with `--no-rag`.
7. **Review** -- Runs all enabled axis evaluators in parallel per file, with configurable concurrency (1--10). Supports graceful interruption via Ctrl+C.
8. **Report** -- Aggregates reviews into a sharded Markdown report and writes `run-metrics.json`.
9. **Badge** -- Optionally injects an Anatoly badge into `README.md`. Disable with `--no-badge`.

Each run writes its artifacts into `.anatoly/runs/<run-id>/`. Old runs are automatically purged when `output.max_runs` is set in config.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Global verdict is `CLEAN` |
| 1 | Global verdict is `NEEDS_REFACTOR` or `CRITICAL` |
| 2 | Fatal error (config, lock, invalid arguments) |

### Examples

```bash
# Full audit with defaults
anatoly run

# Custom run ID, 4 concurrent reviews, skip cache
anatoly run --run-id sprint-42 --concurrency 4 --no-cache

# Filter to a single directory, open report when done
anatoly run --file "src/core/**" --open

# CI mode: plain output, no color, no badge
anatoly run --plain --no-color --no-badge

# Run only duplication detection
anatoly run --axes duplication

# Run correction and tests axes only
anatoly run --axes correction,tests
```

---

## estimate

Pre-run forecast — what the next `anatoly run` will cost in tokens, dollars, and wall-clock time. Makes **no LLM calls**: token counts come from tiktoken, costs from the on-disk pricing cache (litellm + OpenRouter), and the per-axis time estimate uses calibrated medians from past runs. Always rescans the source tree first, so `.anatoly/tasks/` reflects the current state and the forecast block reports fresh `new`/`modified`/`cached` counts (cached files cost $0; new + modified files require a full LLM evaluation).

```
anatoly estimate [--json]
```

### Options

| Flag | Description |
|------|-------------|
| `--json` | Emit a machine-readable JSON payload to stdout instead of the rendered table (logs go to stderr, banner suppressed). Schema versioned via `schemaVersion: 1`. |

### Output sections

The rendered view is built bottom-up — the verdict (Forecast) sits last so the user's eye lands on it next to the prompt.

**Project Info** — name, version, detected languages, frameworks.

**Configuration** — runtime settings + indexing scope merged together. The `rag` line carries the mode and the indexing breadth (e.g. `lite — 8 files · 17 fns · 34 chunks`); the `docs` line shows whether this is a first-run bootstrap or an incremental update.

**Cost breakdown** — one row per pipeline step that hits the LLM (or embedding API), grouped by category (`axis` → `deliberation` → `summary` → `embed` → `internal-doc`) and sorted by cost desc within each group. Five columns:

| Column | Meaning |
|--------|---------|
| `category` | Pipeline phase. Empty on consecutive rows of the same group (visual grouping). |
| `step` | Sub-identifier (axis name like `correction`, embed `code`/`text`, doc `bootstrap`/`update`). |
| `cost` | Pay-per-token equivalent for this step. Prefixed `~` when the value comes from a heuristic (doc, deliberation). |
| `mode` | `subscription` (covered by Claude Code OAuth — you don't pay this), `api` (real per-token bill), `local` (free local runtime). |
| `model` | Resolved model id; local embeddings get a friendly label (e.g. `jina-v2 768d (local)`). |

Two totals close the breakdown:
- `total billed` — sum of `api`-mode rows: what you actually pay.
- `consumption` — sum of all rows: the API equivalent magnitude (informative when subscription covers it).

**Forecast** — decision-grade headlines that recap what's above:
- `files` (X of Y, with skipped count)
- `tokens` (fresh in / out, plus cache-read / cache-write when prompt caching applies, plus embed). Cache tokens are billed at the provider's reduced rate (~10% of input on Anthropic for reads, ~125% for writes) — surfaced separately so the displayed `$/token` ratio reflects total work rather than just fresh input.
- `cost` — billed amount with mode-aware suffix:
  - `$0 in subscription mode (ensure quota for ~$X)` when fully covered
  - `$X in consumption mode` when fully API-billed
  - `$X billed (~$Y consumption equivalent)` for mixed setups
- `time` (calibrated ETA)

#### How token & cache counts are forecast

The forecast does **not** call the LLM — it predicts token volume from the pipeline's structure plus calibrated per-step heuristics, then prices each step against the on-disk pricing cache.

| Step | Fresh input | Output | Cache read / write | Source of the prediction |
|------|-------------|--------|---------------------|---------------------------|
| `axis` (one per axis × file) | system prompt + file content + RAG context (when enabled), tokenized via tiktoken (`cl100k_base`) | `OUTPUT_BASE_PER_FILE + symbols × OUTPUT_TOKENS_PER_SYMBOL`, scaled by `AXIS_OUTPUT_MULTIPLIERS[axisId]` | **Deterministic.** The system prompt is identical across files for a given axis; Anthropic auto-caches identical prefixes. So for E files the estimator emits `cache_creation = SYSTEM_TOKENS` once and `cache_read = SYSTEM_TOKENS × (E−1)`. File content stays fresh (changes per call). | Pipeline construction + tiktoken |
| `summary` (NLP code summarizer) | embed code-token volume | `codeUnits × NLP_TOKENS_PER_FUNCTION` | not modeled (single call per file, cache benefit small) | Heuristic |
| `deliberation` (per shard) | `DELIBERATION_INPUT_PER_SHARD × shardCount` | `DELIBERATION_OUTPUT_PER_SHARD × shardCount` | calibrated `DELIBERATION_CACHE_READ/CREATION_PER_SHARD × shardCount` | **Empirical** — values fitted against R1/R2/R3 bench actuals |
| `internal-doc:bootstrap` / `coherence` / `update` | `DOC_*_PER_PAGE.fresh × pageCount` | `… .output × pageCount` | `… .cacheRead / cacheCreation × pageCount` | **Empirical** — multi-turn agentic Read-tool conversation; values fitted against R1 actuals |

So:
- **Axis cache numbers are exact** given the pipeline runs as specified — they fall out of how Anthropic prompt caching works.
- **Doc and deliberation cache numbers are calibrated estimates**: the multi-turn agent conversation isn't formally derivable, so the per-page / per-shard token shapes were measured on real runs (R1 baseline for doc, R1/R2/R3 for deliberation) and locked into constants. The breakdown table prefixes their `cost` values with `~` and the JSON tags those steps with `approximate: true`.
- **Pricing** uses `cacheReadInput` / `cacheCreationInput` rates from the on-disk pricing cache. Providers without cache rates (non-Anthropic) fall back to the standard `input` rate, yielding the naive cost — which is the right number when no caching exists.

### Example — slot-engine project on Claude Code subscription

```
  Project Info
  ──────────────
  name        slot-engine
  version     0.1.0
  languages   TypeScript 72% · JSON 28%

  Configuration
  ──────────────
  concurrency   8 files · 24 Claude slots
  cache         on
  rag           lite — 8 files · 17 fns · 34 chunks
  docs          first run (bootstrap)

  Cost breakdown
  ──────────────
  category       step                cost   mode           model
  axis           correction         $0.15   subscription   anthropic/claude-sonnet-4-6
                 overengineering    $0.15   subscription   anthropic/claude-sonnet-4-6
                 ...
  deliberation                     ~$0.53   subscription   anthropic/claude-opus-4-6
  summary                           $0.02   subscription   anthropic/claude-haiku-4-5
  embed          code               $0.00   local          jina-v2 768d (local)
                 text               $0.00   local          MiniLM-L6 384d (local)
  internal-doc   bootstrap         ~$0.53   subscription   anthropic/claude-sonnet-4-6

  total billed                      $0.00
  consumption                      ~$1.93

  Forecast
  ──────────────
  files    12 of 15  (3 skipped by triage)
  tokens   ~64K in / ~113K out (+ ~5K cache-read, ~600 cache-write) + ~6K embed
  cost     $0 in subscription mode  (ensure quota for ~$1.93)
  time     ~10m  (default)
```

### JSON mode

`anatoly estimate --json` emits a stable shape that strictly mirrors the rendered table. No banner, no colors; `process.stdout` carries only the JSON.

```json
{
  "schemaVersion": 1,
  "timestamp": "...",
  "project": { "name": "slot-engine", "version": "0.1.0", "languages": "..." },
  "config": {
    "concurrency": 8,
    "cache": true,
    "rag": { "mode": "lite", "files": 8, "fns": 17, "chunks": 34 },
    "docs": { "mode": "bootstrap" }
  },
  "forecast": {
    "files": { "total": 15, "evaluate": 12, "skipped": 3 },
    "tokens": {
      "llm":   { "inputTokens": 63506, "outputTokens": 113300, "cacheReadTokens": 4800, "cacheCreationTokens": 600 },
      "embed": { "tokens": 5696, "codeUnits": 17, "textUnits": 34 },
      "total": 182502
    },
    "cost":  { "billedUsd": 0, "consumptionUsd": 1.93 },
    "time":  { "minutes": 10, "calibrated": false },
    "steps": [
      {
        "category": "axis", "name": "correction",
        "model": "anthropic/claude-sonnet-4-6",
        "billingMode": "subscription",
        "inputTokens": 4089, "outputTokens": 9000,
        "cacheReadTokens": 6600, "cacheCreationTokens": 600,
        "costUsd": 0.151
      }
    ]
  }
}
```

Aggregations like `cost.byModel` or `cost.llmUsd` are intentionally omitted — they're trivially derivable from `forecast.steps[]` (filter by `category` / `model`, sum `costUsd`).

---

## review

Run the agentic review on all pending files sequentially (concurrency 1). Automatically re-reviews all files (implicit `--no-cache`). If no tasks exist, runs an automatic scan first.

```
anatoly review [--axes <list>]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `--axes <list>` | string | Comma-separated list of axes to evaluate. Same values as `run --axes`. |

### Behavior

- Acquires a project lock to prevent concurrent runs.
- Reviews are written to `.anatoly/reviews/` (flat, not run-scoped).
- Supports graceful interruption via Ctrl+C (first press stops new reviews, second force-exits).

### Output

```
review complete -- 42 files | 7 findings | 35 clean

  reviews      /path/to/.anatoly/reviews
  transcripts  /path/to/.anatoly/logs
```

### Examples

```bash
anatoly review
anatoly review --verbose
anatoly review --axes correction,tests
```

---

## report

Aggregate completed review results into a structured, sharded Markdown report. Can regenerate from any previous run.

```
anatoly report [--run <id>]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `--run <id>` | string | Generate report from a specific run. Defaults to the latest run. |

### Behavior

- When `--run` is provided or a latest run directory exists, reads reviews from `.anatoly/runs/<id>/reviews/` and writes the report into that run directory.
- Falls back to the legacy flat `.anatoly/reviews/` directory if no run directory is found.
- Respects the `--open` global flag to open the generated report.

### Output

```
Anatoly Report -- 128 files reviewed
Verdict: NEEDS_REFACTOR

  Correction errors: 3  (high: 1, medium: 2, low: 0)
  Utility:           8  (high: 2, medium: 4, low: 2)
  Duplicates:        2  (high: 0, medium: 2, low: 0)
  Clean:             115

Report: /path/to/.anatoly/runs/20260315-120000/report.md
Details: /path/to/.anatoly/runs/20260315-120000/reviews/
```

### Examples

```bash
anatoly report
anatoly report --run sprint-42 --open
```

---

## watch

Watch for file changes and incrementally re-scan and re-review modified files. Starts with an initial full scan, then monitors configured `scan.include` globs via chokidar.

```
anatoly watch [--axes <list>]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `--axes <list>` | string | Comma-separated list of axes to evaluate. Same values as `run --axes`. |

### Behavior

- Acquires a project lock for the duration of the watch session.
- On file change or addition: re-hashes, re-parses the AST, runs a single-file review, and regenerates the report.
- On file deletion: removes the task, review, and progress entries.
- Files ignored by `.gitignore` are skipped.
- Press Ctrl+C for graceful shutdown.

### Output

```
anatoly -- watch
  watching src/**/*.ts, src/**/*.tsx
  press Ctrl+C to stop

  initial scan 128 files (12 new, 116 cached)

  scanned src/core/scanner.ts
  reviewed src/core/scanner.ts -> CLEAN
```

### Examples

```bash
anatoly watch
anatoly watch --config custom.yml
anatoly watch --axes duplication,correction
```

---

## runs list

List all known audit runs as a clean table (id, reviews, logs, size, status). Pure read-only and scriptable.

```
anatoly runs list [--empty]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `--empty` | boolean | Show only empty (phantom) runs with 0 reviews. |

### Examples

```bash
anatoly runs list
anatoly runs list --empty
```

---

## runs attach

Inspect a run. If the run is still alive, tails its ndjson log live and renders progress and findings in real time. If the run has finished (done / failed / crashed), prints a final snapshot with verdict, findings count, and report path.

```
anatoly runs attach [runId] [--from-start] [--no-color]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `[runId]` | positional | Run ID to attach to. If omitted, auto-selects the only active run. |
| `--from-start` | boolean | Replay the log from the beginning instead of tail-only. |
| `--no-color` | boolean | Disable colors for piping output to files or other tools. |

### Behavior

- **Live mode (running run)**: tails the ndjson log, renders progress + findings, finalises when the run ends.
- **Snapshot mode (finished run)**: prints status, duration, verdict, findings count, and the report path. Exits immediately.
- **Auto-selection (no `runId`)**: requires exactly one running run. Zero or many → error. To snapshot a finished run, pass its `runId` explicitly (see `runs list`).
- **Crash detection**: if a running run's PID is dead, status is reconciled to `crashed` on disk before rendering.
- **Read-only**: the attach process never writes to the run's `anatoly.ndjson` log. The only write it may perform is updating `run-status.json` when detecting a crash.
- **SIGINT (live mode)**: Press Ctrl-C to detach without affecting the target run. Exit code 130.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Run completed with verdict `CLEAN` |
| 1 | Run completed with non-CLEAN verdict, or run failed |
| 2 | Run crashed (PID died) |
| 130 | Detached via Ctrl-C |

### Output

```
anatoly — attach

  run         2026-05-09_143022
  pid         12345
  started     2026-05-09T14:30:22.000Z
  branch      main
  commit      abc1234
  background  true
  log         .anatoly/runs/2026-05-09_143022/anatoly.ndjson
  attached at 2026-05-09T14:31:05.000Z

  (Press Ctrl-C to detach — does not stop the run)

  ▸ phase: scan
  ▹ phase: scan done (2s)
  ▸ phase: review
  CLEAN  src/utils/format.ts
  NEEDS_REFACTOR  src/core/scanner.ts
  ▹ phase: review done (45s)
  ──────────────────────────────────────────────────────────────
  verdict     NEEDS_REFACTOR
  findings    3 findings
  duration    1m 12s
  report      .anatoly/runs/2026-05-09_143022/report.md
```

### Examples

```bash
# Attach to the only active run
anatoly runs attach

# Attach to a specific run by ID
anatoly runs attach 2026-05-09_143022

# Replay full log history then continue tailing
anatoly runs attach --from-start

# Pipe output to a file (no ANSI codes)
anatoly runs attach --no-color > attach.log
```

---

## rag-status

Show RAG index statistics, list all indexed function cards, or inspect a specific function.

```
anatoly rag-status [function] [--all] [--json]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `[function]` | positional | Name of a function to look up in the index. |
| `--all` | boolean | List all indexed function cards, grouped by file. |
| `--json` | boolean | Output results as JSON instead of formatted text. |

### Output (default)

```
anatoly — rag-status

  hardware   cuda (32GB RAM)
  sidecar    running on cuda
  runtime    sidecar
  code model nomic-ai/nomic-embed-code (3584d)
  nlp model  Qwen/Qwen3-Embedding-8B (4096d)

  cards      1024
  files      128
  mode       code-only
  indexed    2026-03-15T12:00:00.000Z

  Use --all to list all cards, or pass a function name to inspect.
```

### Output (function lookup)

```
src/core/scanner.ts:parseFile
  id          abc123
  signature   parseFile(filePath: string, source: string): Symbol[]
  complexity  3/5
  calls       resolveImports, computeHash
```

### Examples

```bash
anatoly rag-status
anatoly rag-status parseFile
anatoly rag-status --all --json
```

---

## runs remove

Delete run directories from `.anatoly/runs/`.

```
anatoly runs remove [runIds...] [--empty | --all | --keep <n>] [-y|--yes]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `[runIds...]` | string | Specific run IDs to remove. |
| `--empty` | boolean | Remove only empty (phantom) runs with 0 reviews. |
| `--all` | boolean | Remove all runs. |
| `--keep <n>` | integer | Remove all runs except the N most recent. |
| `-y, --yes` | boolean | Skip the confirmation prompt. Required for non-interactive environments (CI). |

### Behavior

- Modes are mutually exclusive: pick one of `runIds`, `--empty`, `--all`, or `--keep N`.
- Prompts for confirmation before deleting.
- In non-interactive mode without `--yes`, exits with code 1.

### Examples

```bash
# Remove only empty/phantom runs
anatoly runs remove --empty

# Delete all runs (with confirmation)
anatoly runs remove --all

# Keep the 3 most recent, delete the rest
anatoly runs remove --keep 3

# CI: delete all runs without prompting
anatoly runs remove --all --yes
```

---

## reset

Clear all Anatoly artifacts: cache, reviews, logs, tasks, runs, RAG index, progress, report, and lock file.

```
anatoly reset [-y|--yes]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `-y, --yes` | boolean | Skip the confirmation prompt. Required for non-interactive environments (CI). |

### Behavior

Shows a summary of items that will be deleted, then prompts for confirmation:

```
anatoly -- reset

  The following will be deleted:
    x .anatoly/tasks/
    x .anatoly/reviews/
    x .anatoly/logs/
    x .anatoly/cache/
    x .anatoly/runs (5 run(s))/
    x .anatoly/rag/
    x .anatoly/progress.json
    x .anatoly/report.md
    x .anatoly/anatoly.lock

  Proceed with reset? (y/N)
```

The RAG index is cleaned via the LanceDB API before the directory is removed.

### Examples

```bash
# Interactive reset
anatoly reset

# CI: reset without prompting
anatoly reset --yes
```

---

## local-embeddings

Manage the local embedding backend. The default tier (`lite`, ONNX in-process)
is always available with zero setup; this command exists to **opt into the
advanced GPU/GGUF tier** powered by Docker llama.cpp containers.

```
anatoly local-embeddings <upgrade|status>
```

### Sub-commands

| Sub-command | Description |
|-------------|-------------|
| `upgrade` | Install the advanced backend: pulls Docker llama.cpp server-cuda images, downloads GGUF Q5_K_M models (nomic-embed-code for code, Qwen3-Embedding-8B for NLP), verifies SHA256 integrity, and starts the sidecar. Requires Docker and an NVIDIA GPU with ≥ 12 GB VRAM. |
| `status` | Inspect the current install without making changes. Reports Docker availability, GPU VRAM, which models are downloaded, and whether containers can start. |

### Output

```
anatoly -- local-embeddings status

  docker     available
  gpu        NVIDIA RTX 4090 (24 GB VRAM)

  code model nomic-embed-code (GGUF Q5_K_M)  downloaded (SHA256 OK)
  nlp model  Qwen3-Embedding-8B (GGUF Q5_K_M)  downloaded (SHA256 OK)

  setup complete
```

### Examples

```bash
# Install advanced backend (one-shot, can take several minutes)
npx anatoly local-embeddings upgrade

# Check current install
npx anatoly local-embeddings status
```

---

## hook init

Generate Claude Code hooks configuration for the Anatoly autocorrection loop. Writes (or merges into) `.claude/settings.json`.

```
anatoly hook init
```

### Options

No command-specific options.

### Behavior

Creates a `.claude/settings.json` with two hook registrations:

- **PostToolUse** hook (async): triggers `npx anatoly hook on-edit` after every `Edit` or `Write` tool use. Launches a background single-file review for the changed file.
- **Stop** hook (sync, 180s timeout): triggers `npx anatoly hook on-stop` when Claude Code finishes its task. Waits for pending reviews, collects findings, and returns a `block` decision with the findings as the reason if issues are detected.

If `.claude/settings.json` already has a `hooks` key, the command prints the configuration for manual merging instead of overwriting.

### Internal subcommands

The following subcommands are designed for Claude Code hooks and are not intended for direct user invocation:

| Subcommand | Trigger | Description |
|------------|---------|-------------|
| `hook on-edit` | PostToolUse | Reads stdin JSON, extracts `file_path`, spawns a detached background review. Skips non-TS files, deleted files, files under active lock, and files with unchanged SHA-256 hashes. |
| `hook on-stop` | Stop | Waits up to 120s for running reviews. Filters findings by `min_confidence` from config. Outputs `{"decision":"block","reason":"..."}` if issues found. Includes anti-loop protection via `stop_count` and `max_stop_iterations`. |

### Examples

```bash
# Generate hooks configuration
anatoly hook init

# The hook subcommands are invoked by Claude Code, not directly:
# npx anatoly hook on-edit  (stdin: JSON with tool_input.file_path)
# npx anatoly hook on-stop   (stdin: JSON with stop_hook_active flag)
```
