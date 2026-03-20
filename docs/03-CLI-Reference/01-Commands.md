# Commands

Anatoly provides a pipeline-oriented CLI. The primary command is `run`, which orchestrates the full audit pipeline. Individual stages can also be invoked independently for debugging or incremental workflows.

All commands inherit the [global options](./02-Global-Options.md) defined on the root `anatoly` program.

---

## run

Execute the full audit pipeline: scan, estimate, triage, RAG index, review, and report.

```
anatoly run [--run-id <id>] [--axes <list>]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `--run-id <id>` | string | Custom run identifier. Must be alphanumeric with dashes and underscores. Defaults to an auto-generated timestamp-based ID. |
| `--axes <list>` | string | Comma-separated list of axes to evaluate (e.g. `correction,tests`). Only the listed axes run; others are skipped. Intersects with config-disabled axes. Omit to run all enabled axes. Valid axes: `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices`, `documentation`. |

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

## scan

Parse the AST and compute SHA-256 hashes for all TypeScript files matching the configured `scan.include` / `scan.exclude` globs. Writes one `.task.json` per file into `.anatoly/tasks/`.

```
anatoly scan
```

### Options

No command-specific options. Uses global `--config` and `--file`.

### Output

```
anatoly -- scan
  files     128
  new       12
  cached    116
```

### Examples

```bash
anatoly scan
anatoly scan --config custom.yml
```

---

## estimate

Estimate token counts and review wall-clock time via tiktoken. Makes no LLM calls. If no prior scan exists, runs an automatic scan first.

```
anatoly estimate
```

### Options

No command-specific options.

### Output

```
anatoly -- estimate

  files        128
  symbols      1024
  est. tokens  2.4M input / 480K output
  est. time    ~12 min (x4)
```

The time estimate accounts for the configured `llm.concurrency`.

### Examples

```bash
anatoly estimate
anatoly estimate --file "src/commands/**"
```

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

## clean-runs

Delete run directories from `.anatoly/runs/`.

```
anatoly clean-runs [--keep <n>] [-y|--yes]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `--keep <n>` | integer | Keep the N most recent runs. Deletes the rest. Defaults to 0 (delete all). |
| `-y, --yes` | boolean | Skip the confirmation prompt. Required for non-interactive environments (CI). |

### Behavior

- When `--keep 0` or no `--keep` is specified, prompts for confirmation before deleting all runs.
- In non-interactive mode without `--yes`, exits with code 1.
- Also cleans up legacy flat `.anatoly/logs/` if no run directories are found.

### Examples

```bash
# Delete all runs (with confirmation)
anatoly clean-runs

# Keep the 3 most recent, delete the rest
anatoly clean-runs --keep 3

# CI: delete all runs without prompting
anatoly clean-runs --yes
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

## setup-embeddings

Set up, check, or validate GPU-accelerated embeddings using Docker llama.cpp GGUF containers.

```
anatoly setup-embeddings [--check] [--ab-test]
```

### Options

| Flag | Type | Description |
|------|------|-------------|
| `--check` | boolean | Check current embedding setup status without installing. Reports model availability, Docker status, and VRAM. |
| `--ab-test` | boolean | Run an A/B quality validation comparing GGUF Q5_K_M output against HuggingFace TEI fp16 reference vectors. Used during setup to verify quantization quality. |

### Behavior

**Default (no flags):** Full setup. Pulls Docker llama.cpp server-cuda images, downloads GGUF Q5_K_M quantized models (nomic-embed-code for code, Qwen3-Embedding-8B for NLP), and verifies downloads with SHA256 integrity checks. Requires Docker and an NVIDIA GPU with >= 12 GB VRAM.

**`--check`:** Status check only. Reports whether Docker is available, GPU VRAM, which models are downloaded, and whether containers can start. No modifications made.

**`--ab-test`:** Quality validation. Spins up HuggingFace TEI containers with fp16 reference models and compares their output against the GGUF quantized models. Used to verify that quantization does not degrade embedding quality beyond acceptable thresholds. Run this after setup to validate model integrity.

### Output

```
anatoly -- setup-embeddings

  docker     available
  gpu        NVIDIA RTX 4090 (24 GB VRAM)

  code model nomic-embed-code (GGUF Q5_K_M)  downloaded (SHA256 OK)
  nlp model  Qwen3-Embedding-8B (GGUF Q5_K_M)  downloaded (SHA256 OK)

  setup complete
```

### Examples

```bash
# Full setup
npx anatoly setup-embeddings

# Check status
npx anatoly setup-embeddings --check

# Validate GGUF quality
npx anatoly setup-embeddings --ab-test
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
