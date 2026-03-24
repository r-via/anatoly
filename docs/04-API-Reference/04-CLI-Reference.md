# CLI Reference

> Complete reference for the `anatoly` command-line interface.

## Overview

`anatoly` is the primary executable installed by `@r-via/anatoly`. It exposes an audit pipeline for TypeScript codebases through a set of sub-commands built on [Commander.js](https://github.com/tj/commander.js). The entry point is `./dist/index.js`, registered as the `anatoly` binary.

```bash
anatoly [global-options] <command> [command-options]
```

## Global Options

Global options are accepted by every sub-command and override values set in `.anatoly.yml`.

| Option | Description |
|---|---|
| `--config <path>` | Path to `.anatoly.yml` config file |
| `--verbose` | Show detailed operation logs |
| `--no-cache` | Ignore SHA-256 cache, re-review all files |
| `--file <glob>` | Restrict scope to matching files |
| `--plain` | Disable log-update, linear sequential output |
| `--no-color` | Disable chalk colors (also respects `$NO_COLOR`) |
| `--no-rag` | Disable semantic RAG cross-file analysis |
| `--rebuild-rag` | Force full RAG re-indexation |
| `--rag-lite` | Force lite RAG mode (Jina dual embedding) |
| `--rag-advanced` | Force advanced RAG mode (GGUF Docker GPU) |
| `--code-model <model>` | Embedding model for code vectors (default: auto-detect) |
| `--nlp-model <model>` | Embedding model for NLP vectors (default: auto-detect) |
| `--open` | Open report in default app after generation |
| `--concurrency <n>` | Number of concurrent reviews (1–10) |
| `--sdk-concurrency <n>` | Max concurrent SDK calls (1–20) |
| `--no-triage` | Disable triage, review all files with full agent |
| `--deliberation` | Enable Opus deliberation pass after axis merge |
| `--no-deliberation` | Disable deliberation pass (overrides config) |
| `--no-badge` | Skip README badge injection after audit |
| `--badge-verdict` | Include audit verdict in README badge |
| `--dry-run` | Scan, estimate, triage, then show what would happen |
| `--log-level <level>` | Set log level: `fatal` `error` `warn` `info` `debug` `trace` |
| `--log-file <path>` | Write logs to file in NDJSON format |

---

## Commands

### `init`

Generates a `.anatoly.yml` config file with all defaults commented out.

```bash
anatoly init [options]
```

| Option | Description |
|---|---|
| `--force` | Overwrite an existing `.anatoly.yml` |

---

### `scan`

Parses AST and computes SHA-256 hashes for all source files. Outputs per-file metrics and logs file discovery events. Does not invoke the LLM.

```bash
anatoly scan
```

---

### `estimate`

Shows the startup summary table without making any LLM calls. Auto-scans if no tasks exist, detects the project profile, resolves RAG modes, and displays setup information.

```bash
anatoly estimate
```

---

### `run`

Executes the full audit pipeline: `scan → estimate → triage → RAG indexing → review → report`. This is the primary command for running a complete audit.

```bash
anatoly run [options]
```

| Option | Description |
|---|---|
| `--run-id <id>` | Custom run ID (alphanumeric, dashes, underscores) |
| `--axes <list>` | Comma-separated axes to evaluate (see below) |
| `--no-cache` | Ignore SHA-256 cache, re-review all files |
| `--file <glob>` | Restrict scope to matching files |
| `--concurrency <n>` | Number of concurrent reviews (1–10) |
| `--sdk-concurrency <n>` | Max concurrent SDK calls (1–20) |
| `--no-rag` | Disable semantic RAG cross-file analysis |
| `--rag-lite` | Force lite RAG mode |
| `--rag-advanced` | Force advanced RAG mode (GGUF Docker GPU) |
| `--rebuild-rag` | Force full RAG re-indexation |
| `--code-model <model>` | Embedding model for code vectors |
| `--nlp-model <model>` | Embedding model for NLP vectors |
| `--no-triage` | Disable triage, review all files with full agent |
| `--deliberation` | Enable Opus deliberation pass after axis merge |
| `--no-deliberation` | Disable deliberation pass |
| `--no-badge` | Skip README badge injection |
| `--badge-verdict` | Include audit verdict in README badge |
| `--open` | Open report after generation |
| `--dry-run` | Simulate: scan, estimate, triage, then stop |
| `--plain` | Disable log-update, linear sequential output |
| `--verbose` | Show detailed operation logs |

**Axes** — valid values for `--axes`: `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices`

---

### `review`

Runs agentic review on all pending files sequentially. Useful when resuming a previously interrupted `run`.

```bash
anatoly review [options]
```

| Option | Description |
|---|---|
| `--axes <list>` | Comma-separated axes to evaluate (e.g. `correction,tests`) |

---

### `report`

Aggregates completed review results into a structured Markdown report. Supports both run-scoped and legacy report modes.

```bash
anatoly report [options]
```

| Option | Description |
|---|---|
| `--run <id>` | Generate report from a specific run (default: latest) |

---

### `status`

Shows current audit progress, findings summary, progress bars, and per-file status counts.

```bash
anatoly status
```

---

### `watch`

Watches for file changes and incrementally re-scans and re-reviews modified files. Uses chokidar internally; regenerates the report after each review.

```bash
anatoly watch [options]
```

| Option | Description |
|---|---|
| `--axes <list>` | Comma-separated axes to evaluate (e.g. `correction,tests`) |

---

### `rag-status`

Shows RAG index status with vector store statistics. Optionally searches or lists function cards and doc sections.

```bash
anatoly rag-status [function] [options]
```

| Argument / Option | Description |
|---|---|
| `[function]` | Optional function name to search in the index |
| `--all` | List all indexed function cards |
| `--docs` | List all indexed doc sections |
| `--json` | Output as JSON |

---

### `reset`

Clears all cache, reviews, logs, tasks, report, RAG index, and internal docs. Includes LanceDB vector store cleanup.

```bash
anatoly reset [options]
```

| Option | Description |
|---|---|
| `-y, --yes` | Skip confirmation prompt (for CI/scripts) |
| `--keep-rag` | Keep the RAG index (embeddings are slow to rebuild) |
| `--keep-docs` | Keep internal documentation (`.anatoly/docs/`) |

---

### `clean-runs`

Deletes runs from `.anatoly/runs/`. Without `--keep`, all runs are removed.

```bash
anatoly clean-runs [options]
```

| Option | Description |
|---|---|
| `--keep <n>` | Keep the N most recent runs |
| `-y, --yes` | Skip confirmation prompt (for CI/scripts) |

---

### `setup-embeddings`

Installs GPU embedding backends (lite / fp16 / GGUF) by delegating to a setup script.

```bash
anatoly setup-embeddings [options]
```

| Option | Description |
|---|---|
| `--check` | Check current embedding setup status without installing |
| `--ab-test` | Run A/B test comparing bf16 vs GGUF embedding quality |

---

### `clean`

Generates Ralph (autonomous agent) artifacts from audit findings. Produces a PRD with user stories, a `CLAUDE.md` with agent instructions, and a `progress.txt` learnings log.

```bash
anatoly clean
```

---

### `clean-run`

Runs the Ralph remediation loop against the specified report file. Requires a non-`main`/`master` branch; includes a circuit breaker and git-based rollback.

```bash
anatoly clean-run <report-file> [options]
```

| Argument / Option | Description |
|---|---|
| `<report-file>` | Path to the audit report file to remediate |
| `-n, --iterations <n>` | Max Ralph iterations (default: `10`) |

---

### `clean-sync`

Syncs completed Ralph tasks back to axis reports. Updates shard checkboxes and the axis index when all actions in a shard are complete.

```bash
anatoly clean-sync
```

---

### `docs`

Manages internal documentation under `.anatoly/docs/`. All functionality is exposed through sub-commands.

#### `docs scaffold`

Scaffolds documentation. `scope` is `internal` (default, generates `.anatoly/docs/`) or `project` (copies internal docs to `docs/`).

```bash
anatoly docs scaffold [scope] [options]
```

| Option | Description |
|---|---|
| `-y, --yes` | Skip confirmation prompt |
| `--plain` | Linear sequential output |

#### `docs lint`

Lints `.anatoly/docs/` structure: fixes preamble, fences, checks index integrity, and validates links.

```bash
anatoly docs lint
```

#### `docs coherence`

Runs deterministic structure lint followed by an Opus coherence review on `.anatoly/docs/`.

```bash
anatoly docs coherence [options]
```

| Option | Description |
|---|---|
| `--max-loops <n>` | Max audit-fix-verify loops (default: `3`) |
| `--lint-only` | Skip Opus coherence review, only run deterministic lint |

#### `docs index`

Performs incremental RAG indexing: code cards, NLP summaries, and doc chunks.

```bash
anatoly docs index [options]
```

| Option | Description |
|---|---|
| `--plain` | Linear sequential output |
| `--rebuild` | Force full re-index (ignore cache) |

#### `docs gap-detection`

Analyzes coverage gaps between the code index and the doc index. `scope` is `internal` (`.anatoly/docs/`) or `project` (`docs/`).

```bash
anatoly docs gap-detection <scope> [options]
```

| Option | Description |
|---|---|
| `--gap-threshold <n>` | Similarity below this value = `NOT_FOUND` (default: `0.60`) |
| `--drift-threshold <n>` | Similarity below this value = `LOW_RELEVANCE` (default: `0.85`) |
| `--json` | Output as JSON |

#### `docs status`

Shows internal documentation generation status.

```bash
anatoly docs status
```

---

### `hook` (internal)

Registers Claude Code integration hooks. These sub-commands are invoked by Claude Code's hook system and are **not intended for direct user invocation**.

| Sub-command | Description |
|---|---|
| `hook on-edit` | `PostToolUse` hook: queues a background review for the edited file |
| `hook on-stop` | `Stop` hook: waits for reviews, then injects findings as feedback |
| `hook init` | Generates `.claude/settings.json` with hook configuration |

---

## Examples

### Run a full audit

```bash
anatoly run --axes correction,tests --concurrency 4 --open
```

### Preview scope without LLM calls

```bash
anatoly run --dry-run --verbose
```

### Audit only files matching a glob

```bash
anatoly run --file "src/core/**/*.ts" --no-rag
```

### Generate a report from a specific run

```bash
anatoly report --run 2024-01-15-abc123
```

### Inspect a function card in the RAG index

```bash
anatoly rag-status loadConfig --json
```

### Reset everything except the RAG index

```bash
anatoly reset --keep-rag --yes
```

### Retain only the three most recent runs

```bash
anatoly clean-runs --keep 3 --yes
```

### Scaffold then lint internal documentation

```bash
anatoly docs scaffold internal --yes
anatoly docs lint
```

### Watch for file changes during development

```bash
anatoly watch --axes correction,best_practices
```

### Generate the config template

```bash
anatoly init
# Edit .anatoly.yml with project-specific settings
```

---

## See Also

- [Configuration Schema](02-Configuration-Schema.md) — all `.anatoly.yml` keys that correspond to the global options above
- [Public API](01-Public-API.md) — exported TypeScript functions underlying each command
- [Common Workflows](../03-Guides/01-Common-Workflows.md) — step-by-step guides for typical audit scenarios
- [Advanced Configuration](../03-Guides/02-Advanced-Configuration.md) — tuning concurrency, RAG mode, and model overrides
- [Module: commands](../05-Modules/01-commands.md) — source-level reference for all command registration functions
- [Troubleshooting](../03-Guides/03-Troubleshooting.md) — common errors and diagnostics
