# CLI Reference

> Complete reference for all `anatoly` CLI commands, sub-commands, and options.

## Overview

`anatoly` is the primary executable installed by `@r-via/anatoly`. It exposes an audit pipeline for codebases through a set of sub-commands built on [Commander.js](https://github.com/tj/commander.js). The entry point is `./dist/index.js`, registered as the `anatoly` binary.

```bash
anatoly [global-options] <command> [command-options]
```

**Exit codes**

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error or audit failure |
| `2` | Usage / validation error |

## Global Options

Global options are accepted by every sub-command and override values set in `.anatoly.yml`.

| Option | Description |
|--------|-------------|
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

---

## Commands

### `init`

Generates a `.anatoly.yml` config file with all defaults commented out. Uses Zod schema defaults as source of truth.

```bash
anatoly init [--force]
```

| Option | Description |
|--------|-------------|
| `--force` | Overwrite an existing `.anatoly.yml` |

---

### `scan`

Parses AST via `web-tree-sitter` and computes SHA-256 hashes for all source files matching `scan.include`. Writes task JSON files to `.anatoly/tasks/`. Does not invoke the LLM.

```bash
anatoly scan
```

`run` performs an automatic scan as its first phase. Use `scan` standalone to pre-populate the task cache or inspect the file count before committing to a full audit.

---

### `estimate`

Prints the startup summary table without making any LLM calls. Auto-scans if no tasks exist, detects the project profile, resolves RAG modes, and displays a calibrated ETA.

```bash
anatoly estimate
```

---

### `run`

Executes the full audit pipeline: `scan → triage → RAG indexing → review → report`. This is the primary command for a complete audit.

```bash
anatoly run [options]
```

| Option | Description |
|--------|-------------|
| `--run-id <id>` | Custom run ID (alphanumeric, dashes, underscores). Auto-generated if omitted. |
| `--axes <list>` | Comma-separated axes to evaluate (see valid values below) |
| `--no-cache` | Ignore SHA-256 cache, re-review all files |
| `--file <glob>` | Restrict scope to files matching this glob |
| `--concurrency <n>` | Concurrent file reviews, 1–10 |
| `--sdk-concurrency <n>` | Max concurrent SDK calls, 1–20 |
| `--no-rag` | Disable semantic RAG cross-file analysis for this run |
| `--rag-lite` | Force lite RAG mode (Jina v2, CPU) |
| `--rag-advanced` | Force advanced RAG mode (GGUF Docker GPU). Mutually exclusive with `--rag-lite`. |
| `--rebuild-rag` | Force full RAG re-indexation, ignoring existing index |
| `--code-model <model>` | Embedding model for code vectors |
| `--nlp-model <model>` | Embedding model for NLP vectors |
| `--no-triage` | Disable triage; evaluate every file with the full agent |
| `--deliberation` | Enable Opus deliberation pass after axis merge |
| `--no-deliberation` | Disable deliberation pass |
| `--no-badge` | Skip README badge injection |
| `--badge-verdict` | Include audit verdict in README badge |
| `--open` | Open report after generation |
| `--dry-run` | Simulate: scan, estimate, triage, print what would happen — no LLM calls |
| `--plain` | Disable animated display; linear sequential output (auto-set in non-TTY) |
| `--verbose` | Show detailed per-operation logs |

**Valid `--axes` values:** `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices`, `documentation`

---

### `review`

Runs the agentic review on all pending files sequentially. Unlike `run`, this command skips the scan, triage, RAG, and report phases; it always re-reviews all files regardless of cache state.

```bash
anatoly review [--axes <list>]
```

| Option | Description |
|--------|-------------|
| `--axes <list>` | Comma-separated axes to evaluate (e.g. `correction,tests`) |

If an audit lock is already active, the command exits immediately with code `1`.

---

### `report`

Aggregates completed review results into a sharded Markdown report. Supports both run-scoped and legacy flat-directory modes.

```bash
anatoly report [--run <id>]
```

| Option | Description |
|--------|-------------|
| `--run <id>` | Generate report from a specific run ID (default: latest) |

---

### `status`

Prints current audit progress, a visual progress bar, per-status file counts (`PENDING`, `IN_PROGRESS`, `DONE`, `CACHED`, `ERROR`, `TIMEOUT`), and a findings summary from the latest completed run.

```bash
anatoly status
```

---

### `watch`

Watches for file changes with [chokidar](https://github.com/paulmillr/chokidar) and incrementally re-scans and re-reviews modified files. The report is regenerated after each successful review. Deleted files are removed from the task list and review cache.

```bash
anatoly watch [--axes <list>]
```

| Option | Description |
|--------|-------------|
| `--axes <list>` | Restrict evaluation to these axes for every watch-triggered review |

Press `Ctrl+C` to stop. The lock is released on graceful shutdown.

---

### `rag-status [function]`

Inspects the LanceDB vector index. Without arguments, prints aggregate statistics (card count, file count, doc section count, summaries count) along with the resolved embedding models and vector dimensions. Providing a function name prints the stored card for that function.

```bash
anatoly rag-status [function] [options]
```

| Argument / Option | Description |
|-------------------|-------------|
| `[function]` | Optional function name to look up in the index |
| `--all` | List all indexed function cards |
| `--docs` | List all indexed doc sections |
| `--json` | Output as JSON |
| `--lite` | Filter to lite-mode index entries |
| `--advanced` | Filter to advanced-mode index entries |

---

### `reset`

Drops all Anatoly-managed artifacts: cache, reviews, logs, tasks, reports, RAG index, and internal docs. LanceDB tables are dropped before filesystem removal.

```bash
anatoly reset [options]
```

| Option | Description |
|--------|-------------|
| `--keep-rag` | Preserve the LanceDB vector index (slow to rebuild) |
| `--keep-docs` | Preserve `.anatoly/docs/` internal documentation |
| `--yes` | Skip the interactive confirmation prompt |

---

### `clean runs`

Deletes run directories from `.anatoly/runs/`. Also removes the legacy `.anatoly/logs/` directory if present. Without `--keep`, all runs are removed.

```bash
anatoly clean runs [options]
```

| Option | Description |
|--------|-------------|
| `--keep <n>` | Keep the N most recent runs; delete the rest |
| `--yes` | Skip the interactive confirmation prompt |

---

### `setup-embeddings`

Installs local embedding model backends for the RAG pipeline by delegating to the bundled `setup-embeddings.sh` script with `ANATOLY_PROJECT_ROOT` set.

```bash
anatoly setup-embeddings [--check]
```

| Option | Description |
|--------|-------------|
| `--check` | Inspect current embedding model status without installing anything |

See [setup-embeddings module](../05-Modules/07-setup-embeddings.md) for model details and hardware requirements.

---

### `clean generate <target>`

Generates [Ralph Pattern](https://paddo.dev/blog/ralph-wiggum-autonomous-loops/) remediation artifacts from unchecked audit findings. Parses `ACT-ID` checkboxes in the axis shard reports and produces three files under `.anatoly/clean/<target>/`:

- `prd.json` — user stories with acceptance criteria per finding
- `CLAUDE.md` — agent instructions for the autonomous loop
- `progress.txt` — iteration learnings log

```bash
anatoly clean generate <target>
```

Valid targets: `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices`, `documentation`, or `all`.

---

### `clean run <target>`

Orchestrates an iterative autonomous remediation loop. Spawns `claude --dangerously-skip-permissions --print` in a loop (up to `--iterations` times), feeds each iteration the `CLAUDE.md` prompt, then syncs completed fixes back to the axis report via `clean sync`.

```bash
anatoly clean run <target> [options]
```

| Argument / Option | Description |
|-------------------|-------------|
| `<target>` | Axis name (e.g. `correction`), `all`, or path to a shard `.md` file |
| `-n, --iterations <n>` | Maximum Ralph iterations (default: `10`) |

**Branch isolation:** automatically checks out the branch from `prd.json`. Refuses to execute on `main` or `master`. A circuit breaker trips after three consecutive no-progress iterations (no git diff) or five consecutive errored iterations, rolling back to the last good commit.

**Prerequisites:** `git` must be available on `$PATH`. The `claude` CLI (Claude Code) must be installed and authenticated.

---

### `clean sync <target>`

Reads `prd.json` for the given target and checks off the corresponding `ACT-ID` checkboxes in the axis shard Markdown files for all user stories where `passes: true`. Updates the axis index file when all shards in an axis are complete. Ignores `DISCOVERED` stories added by the agent during iteration.

```bash
anatoly clean sync <target>
```

Valid targets: same as `clean generate`. Called automatically by `clean run` after each iteration and at circuit breaker exit.

---

### `docs <subcommand>`

Manages internal documentation under `.anatoly/docs/`. All subcommands orchestrate LLM calls (Sonnet/Opus/Haiku) and update the RAG index. `docs scaffold` runs on the first `run` invocation automatically; `docs update` runs on subsequent `run` invocations.

#### `docs scaffold [scope]`

Scaffolds documentation in three phases: parallel Sonnet generation → Opus coherence review → RAG index. `scope` is `internal` (default, writes `.anatoly/docs/`) or `project` (copies internal docs to `docs/`).

```bash
anatoly docs scaffold [internal|project] [--yes] [--plain]
```

#### `docs lint`

Runs deterministic structure checks on `.anatoly/docs/`: preamble validation, fence tags, index integrity, and link resolution.

```bash
anatoly docs lint
```

#### `docs coherence`

Runs deterministic lint followed by an Opus coherence review with audit-fix-verify loops.

```bash
anatoly docs coherence [--max-loops <n>] [--lint-only]
```

| Option | Description |
|--------|-------------|
| `--max-loops <n>` | Maximum audit-fix-verify loops (default: `3`) |
| `--lint-only` | Skip Opus review; run only deterministic lint |

#### `docs index`

Performs incremental RAG indexing: code cards + NLP summaries + doc chunks.

```bash
anatoly docs index [--rebuild] [--plain]
```

| Option | Description |
|--------|-------------|
| `--rebuild` | Force full re-index, ignoring cache |
| `--plain` | Linear sequential output |

#### `docs update`

Runs RAG-based gap detection and generates targeted documentation updates for under-documented symbols and stale sections.

```bash
anatoly docs update
```

#### `docs gap-detection <scope>`

Analyzes coverage gaps by comparing the code index against the doc index using cosine similarity.

```bash
anatoly docs gap-detection <internal|project> [--gap-threshold <n>] [--drift-threshold <n>] [--json]
```

| Option | Description |
|--------|-------------|
| `--gap-threshold <n>` | Similarity below this value is `NOT_FOUND` (default: `0.60`) |
| `--drift-threshold <n>` | Similarity below this value is `LOW_RELEVANCE` (default: `0.85`) |
| `--json` | Output as JSON |

#### `docs status`

Prints documentation health metrics for `.anatoly/docs/`.

```bash
anatoly docs status
```

---

### `hook <subcommand>` (internal)

Registers or invokes Claude Code integration hooks for a real-time write → audit → fix loop. These sub-commands are invoked by Claude Code's hook system and are **not intended for direct user invocation** (except `hook init`).

| Sub-command | Description |
|-------------|-------------|
| `hook init` | Writes `.claude/settings.json` with `PostToolUse` and `Stop` hook configuration |
| `hook on-edit` | `PostToolUse` hook: debounced background review for the edited TypeScript file |
| `hook on-stop` | `Stop` hook: collects findings and injects them as completion feedback |

---

## Examples

### Full audit with specific axes

```bash
npx anatoly run --axes correction,tests --concurrency 4 --open
```

### Dry-run to preview scope without spending tokens

```bash
npx anatoly run --dry-run --verbose
```

### Audit only a subdirectory

```bash
npx anatoly run --file "src/core/**/*.ts" --no-rag
```

### CI pipeline — non-interactive, fail on findings

```bash
npx anatoly run --plain --no-deliberation --axes correction,tests
# exit 0 = clean, exit 1 = findings present
```

### Generate a report from a specific run

```bash
npx anatoly report --run 2024-01-15-abc123
```

### Inspect a function card in the RAG index

```bash
npx anatoly rag-status loadConfig --json
```

### Reset everything except the RAG index

```bash
npx anatoly reset --keep-rag --yes
```

### Keep only the three most recent runs

```bash
npx anatoly clean runs --keep 3 --yes
```

### Autonomous remediation loop (Ralph Pattern)

```bash
# Generate PRD + CLAUDE.md from unchecked correction findings
npx anatoly clean generate correction

# Run up to 5 autonomous fix iterations
npx anatoly clean run correction --iterations 5

# Sync completed story checkboxes back to the report
npx anatoly clean sync correction
```

### Scaffold then lint internal documentation

```bash
npx anatoly docs scaffold internal --yes
npx anatoly docs lint
```

### Watch mode during development

```bash
npx anatoly watch --axes correction,best_practices
```

---

## See Also

- [Configuration Schema](02-Configuration-Schema.md) — all `.anatoly.yml` keys corresponding to the global options above
- [Public API](01-Public-API.md) — exported TypeScript functions underlying each command
- [Common Workflows](../03-Guides/01-Common-Workflows.md) — step-by-step guides for typical audit scenarios
- [Advanced Configuration](../03-Guides/02-Advanced-Configuration.md) — tuning concurrency, RAG mode, and model overrides
- [Module: commands](../05-Modules/01-commands.md) — source-level reference for all command registration functions
- [setup-embeddings module](../05-Modules/07-setup-embeddings.md) — embedding model setup details
- [Troubleshooting](../03-Guides/03-Troubleshooting.md) — common errors and diagnostics
