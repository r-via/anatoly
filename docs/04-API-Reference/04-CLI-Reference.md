# CLI Reference

> Complete reference for all `anatoly` CLI commands, options, and arguments.

## Overview

The `anatoly` binary exposes a suite of commands that cover the full deep-audit lifecycle: scanning source files, estimating cost, running AI-powered reviews, generating reports, maintaining the RAG index, and integrating with Claude Code via hooks. All commands are registered from `src/commands/index.ts` and built on the `commander` library.

## Prerequisites

- **Node.js** ≥ 20.19

## Installation

```bash
npm install @r-via/anatoly
```

The `postinstall` script (`scripts/download-model.js`) downloads required embedding model weights automatically.

---

## Command Quick Reference

| Command | Description |
|---|---|
| [`scan`](#scan) | Parse AST and hash all source files |
| [`estimate`](#estimate) | Show startup summary without LLM calls |
| [`run`](#run) | Full pipeline: scan → review → report |
| [`review`](#review) | Run agentic review on pending files |
| [`report`](#report) | Aggregate reviews into a Markdown report |
| [`watch`](#watch) | Watch files and incrementally re-review |
| [`status`](#status) | Show audit progress and findings summary |
| [`rag-status`](#rag-status) | Inspect RAG index statistics or function cards |
| [`init`](#init) | Generate a commented `.anatoly.yml` config |
| [`setup-embeddings`](#setup-embeddings) | Install GPU embedding backends |
| [`reset`](#reset) | Clear all cache, reviews, logs, and RAG data |
| [`clean-runs`](#clean-runs) | Delete run history from `.anatoly/runs/` |
| [`docs`](#docs) | Manage internal documentation |
| [`hook`](#hook) | Claude Code integration hooks |
| [`clean`](#clean) | Generate Ralph remediation artifacts |
| [`clean-run`](#clean-run) | Execute Ralph autocorrection loop |
| [`clean-sync`](#clean-sync) | Sync completed fixes back to axis reports |

---

## Core Pipeline

### `scan`

Parses the AST of every source file and computes SHA-256 hashes. Results are stored in the task cache to enable incremental reviews.

```bash
anatoly scan
```

**Output:**

```
anatoly — scan
  files     132
  new       18
  cached    114
```

---

### `estimate`

Displays the full startup summary table — project info, evaluator list, triage breakdown, RAG config, token count, and calibrated ETA — without making any LLM calls.

```bash
anatoly estimate
```

Runs an implicit `scan` if no task directory exists.

---

### `run`

Executes the complete audit pipeline: scan → estimate → review → report. Accepts the broadest set of options to control scope, concurrency, caching, RAG behaviour, and output.

```bash
anatoly run [options]
```

**Options:**

| Flag | Description |
|---|---|
| `--run-id <id>` | Custom run ID (alphanumeric, dashes, underscores) |
| `--axes <list>` | Comma-separated axes to enable (e.g. `correction,tests`) |
| `--no-cache` | Ignore SHA-256 cache; re-review all files |
| `--file <glob>` | Restrict review scope to matching files |
| `--concurrency <n>` | Concurrent file reviews (1–10) |
| `--sdk-concurrency <n>` | Max concurrent SDK calls (1–20) |
| `--no-rag` | Disable RAG cross-file analysis |
| `--rag-lite` | Force lite RAG mode (Jina dual embedding) |
| `--rag-advanced` | Force advanced RAG mode (GGUF GPU Docker) |
| `--rebuild-rag` | Force full RAG re-indexation |
| `--code-model <model>` | Embedding model for code vectors |
| `--nlp-model <model>` | Embedding model for NLP vectors |
| `--no-triage` | Disable triage; review all files with the full agent |
| `--deliberation` | Enable Opus deliberation pass after axis merge |
| `--no-deliberation` | Disable deliberation pass |
| `--no-badge` | Skip README badge injection |
| `--badge-verdict` | Include audit verdict in README badge |
| `--open` | Open report in default application after generation |
| `--dry-run` | Simulate without executing reviews |
| `--plain` | Disable log-update; use linear sequential output |
| `--verbose` | Show detailed operation logs |

**Pipeline phases:**

1. **Setup** — scan, estimate, triage, build usage graph
2. **Bootstrap-Doc** *(first run only)* — scaffold and generate internal documentation
3. **RAG Index** *(if enabled)* — index and embed code, summaries, and docs
4. **Review pass 1** — evaluate all pending files with enabled axes
5. **Internal Docs** — update documentation for changed source files
6. **Review pass 2** *(first run only, if bootstrap complete)* — re-evaluate with updated docs
7. **Report** — aggregate findings, generate Markdown report, inject badge

**Output:**

```
Done — 132 files | 14 findings | 118 clean (22 skipped · 110 evaluated) | 4m 32s

  run          run-2026-03-23-001
  report       .anatoly/report.md
  reviews      .anatoly/reviews/
  transcripts  .anatoly/runs/run-2026-03-23-001/transcripts/
  log          .anatoly/runs/run-2026-03-23-001/run.log

  Cost: $0.43 in API calls · $0.00 with Claude Code
```

---

### `review`

Runs the agentic review on all pending files sequentially. Unlike `run`, this command does not scan, triage, or generate a report — it reviews pending tasks only.

```bash
anatoly review [--axes <list>]
```

On invocation, all files previously marked `DONE` or `CACHED` are reset to `PENDING`, so the command always re-reviews the full working set.

**Options:**

| Flag | Description |
|---|---|
| `--axes <list>` | Comma-separated axes to evaluate |

---

### `report`

Aggregates review results from `.anatoly/reviews/` into a structured Markdown report.

```bash
anatoly report [--run <id>] [--open]
```

**Options:**

| Flag | Description |
|---|---|
| `--run <id>` | Generate report from a specific run (default: latest) |
| `--open` | Open the report in the default application after generation |

---

### `watch`

Watches configured file patterns for changes and incrementally re-scans and re-reviews modified files. Debounces rapid saves with a 200 ms stability window.

```bash
anatoly watch [--axes <list>]
```

**Options:**

| Flag | Description |
|---|---|
| `--axes <list>` | Comma-separated axes to evaluate |

Handles file deletions by cleaning up associated reviews and tasks. Regenerates the report after each successful review. Graceful shutdown on `SIGINT`.

---

## Inspection

### `status`

Displays current audit progress, file counts, findings by axis, and global verdict.

```bash
anatoly status
```

**Output:**

```
anatoly — status

  progress    [████████████░░░░░░░░░░] 55% (73/132)

  total       132
  pending     59
  done        73
  cached      0

  verdict     WARN
  findings    9
    correction  4
    tests       3
    utility     2

  latest run  run-2026-03-23-001
  report      .anatoly/report.md
  reviews     .anatoly/reviews/
```

---

### `rag-status`

Shows statistics for the RAG index (lite and/or advanced modes), or inspects a specific function card by name.

```bash
anatoly rag-status [function] [options]
```

**Options:**

| Flag | Description |
|---|---|
| `--all` | List all indexed function cards |
| `--docs` | List all indexed doc sections |
| `--json` | Output as JSON |

**Output:**

```
anatoly — rag-status

  lite index
    cards        150
    files        45
    summaries    120/150 (80%)
    mode         dual (code + NLP)
    code model   jina-v2 (768d)
    nlp model    MiniLM (384d)
    indexed      2026-03-23T10:30:00Z
```

---

## Configuration & Setup

### `init`

Generates a `.anatoly.yml` file in the project root with all configuration defaults, with every line commented out for reference.

```bash
anatoly init [--force]
```

**Options:**

| Flag | Description |
|---|---|
| `--force` | Overwrite an existing `.anatoly.yml` |

---

### `setup-embeddings`

Installs embedding backends (lite/fp16/GGUF) for GPU-accelerated semantic search. Delegates to the bundled `setup-embeddings.sh` script.

```bash
anatoly setup-embeddings [--check] [--ab-test]
```

**Options:**

| Flag | Description |
|---|---|
| `--check` | Check current embedding setup status without installing |
| `--ab-test` | Run A/B comparison between bf16 and GGUF embedding quality |

---

## Maintenance

### `reset`

Clears all generated artefacts: tasks, reviews, logs, cache, runs, RAG index, internal docs, progress state, report, lock file, and memory files.

```bash
anatoly reset [options]
```

**Options:**

| Flag | Description |
|---|---|
| `-y, --yes` | Skip confirmation prompt |
| `--keep-rag` | Preserve the RAG index (`.anatoly/rag/`) |
| `--keep-docs` | Preserve internal documentation (`.anatoly/docs/`) |

---

### `clean-runs`

Deletes run directories from `.anatoly/runs/`, with an optional retention count.

```bash
anatoly clean-runs [--keep <n>] [--yes]
```

**Options:**

| Flag | Description |
|---|---|
| `--keep <n>` | Retain the N most recent runs |
| `-y, --yes` | Skip confirmation (required in non-interactive environments) |

---

## Internal Docs

### `docs scaffold`

Deletes and fully regenerates all internal documentation under `.anatoly/docs/` via Claude Sonnet.

```bash
anatoly docs scaffold [--yes] [--plain]
```

### `docs status`

Displays the count of scaffolded vs. generated internal documentation pages.

```bash
anatoly docs status
```

**Output:**

```
  .anatoly/docs/: 45 pages (30 generated, 15 scaffolded-only)
```

---

## Hook Integration

### `hook init`

Generates the Claude Code hooks configuration in `.claude/settings.json`, registering the `PostToolUse` and `Stop` hooks.

```bash
anatoly hook init
```

The generated configuration wires up:
- **PostToolUse** (on `Edit` / `Write`): calls `anatoly hook on-edit` asynchronously
- **Stop**: calls `anatoly hook on-stop` with a 180 s timeout

### `hook on-edit`

Internal. Reads a Claude Code `PostToolUse` JSON payload from stdin and spawns a detached background review for the edited file. Skips non-TypeScript files and debounces rapid edits.

```bash
anatoly hook on-edit
```

### `hook on-stop`

Internal. Waits up to 120 s for any running background reviews to complete, collects findings above the configured `min_confidence` threshold, and emits a Claude Code Stop hook payload that blocks task completion and injects findings as feedback.

```bash
anatoly hook on-stop
```

---

## Remediation (Ralph Loop)

### `clean`

Generates Ralph remediation artefacts (`prd.json`, `CLAUDE.md`, `progress.txt`) from an axis shard report.

```bash
anatoly clean <axis>
```

`<axis>` is one of `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices`, or `all`.

### `clean-run`

Runs the Ralph autocorrection loop against a shard report file, iterating until all findings are resolved or a circuit-breaker threshold is reached.

```bash
anatoly clean-run <report-file> [-n <iterations>]
```

**Options:**

| Flag | Description |
|---|---|
| `-n, --iterations <n>` | Maximum Ralph iterations (default: 10) |

The circuit breaker opens after 3 consecutive iterations with no progress, or 5 consecutive iterations that produce the same error. On open, the working tree is rolled back to the last good commit.

### `clean-sync`

Reads completed stories from `prd.json` and checks off the corresponding action items in axis shard reports.

```bash
anatoly clean-sync <axis>
```

---

## Examples

**Run a full audit restricted to `correction` and `tests` axes, without cache:**

```bash
anatoly run --axes correction,tests --no-cache
```

**Run a full audit on a single file with verbose output:**

```bash
anatoly run --file "src/core/scanner.ts" --verbose
```

**Check progress during a running audit:**

```bash
anatoly status
```

**Inspect the RAG index and list all indexed function cards:**

```bash
anatoly rag-status --all
```

**Set up Claude Code hooks for the autocorrection loop:**

```bash
anatoly hook init
```

**Reset everything except the RAG index (embeddings are slow to rebuild):**

```bash
anatoly reset --keep-rag --yes
```

**Generate a remediation PRD for the `correction` axis and start the Ralph loop:**

```bash
anatoly clean correction
anatoly clean-run .anatoly/runs/run-2026-03-23-001/shards/correction/shard.0.md -n 5
```

---

## See Also

- [Configuration Reference](../03-Configuration/01-Config-File.md) — `.anatoly.yml` schema and all configuration keys
- [RAG Overview](../02-Concepts/04-RAG.md) — How the semantic search index works
- [Hook Integration](../02-Concepts/06-Hook-Integration.md) — Claude Code autocorrection loop architecture
- [Ralph Clean Loop](../02-Concepts/07-Ralph-Clean-Loop.md) — Automated remediation workflow
- [Internal Documentation](../02-Concepts/05-Internal-Docs.md) — How `.anatoly/docs/` is generated and used
