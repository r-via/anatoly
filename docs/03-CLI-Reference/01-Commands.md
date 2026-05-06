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
- `tokens` (in / out + embed)
- `cost` — billed amount with mode-aware suffix:
  - `$0 in subscription mode (ensure quota for ~$X)` when fully covered
  - `$X in consumption mode` when fully API-billed
  - `$X billed (~$Y consumption equivalent)` for mixed setups
- `time` (calibrated ETA)

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
  tokens   ~64K in / ~113K out + ~6K embed
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
      "llm":   { "inputTokens": 63506, "outputTokens": 113300 },
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

## status

Show current audit progress and a findings summary.

```
anatoly status
```

### Options

No command-specific options.

### Output

```
anatoly -- status

  progress    [=========>          ] 45% (58/128)

  total       128
  pending     70
  done        48
  cached      10
  error       0

  verdict     NEEDS_REFACTOR
  findings    12
    dead      3
    dup       2
    over      4
    errors    3

  latest run  20260315-120000
  report      /path/to/.anatoly/runs/20260315-120000/report.md
  reviews     /path/to/.anatoly/runs/20260315-120000/reviews/
```

### Examples

```bash
anatoly status
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

## audit remove

Delete run directories from `.anatoly/runs/`.

```
anatoly audit remove [runIds...] [--empty | --all | --keep <n>] [-y|--yes]
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
anatoly audit remove --empty

# Delete all runs (with confirmation)
anatoly audit remove --all

# Keep the 3 most recent, delete the rest
anatoly audit remove --keep 3

# CI: delete all runs without prompting
anatoly audit remove --all --yes
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
