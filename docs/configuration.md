# Configuration

Anatoly is configured via a `.anatoly.yml` file at the project root and CLI flags. All settings are optional — sensible defaults apply.

## Table of Contents

- [Config File Reference](#config-file-reference)
  - [project](#project)
  - [scan](#scan)
  - [coverage](#coverage)
  - [llm](#llm)
  - [llm.axes](#llmaxes)
  - [rag](#rag)
  - [badge](#badge)
  - [logging](#logging)
  - [output](#output)
- [CLI Flags](#cli-flags)
  - [Global Flags](#global-flags)
  - [Command-Specific Options](#command-specific-options)
- [Environment Variables](#environment-variables)
- [Review Output](#review-output)
- [Examples](#examples)

---

## Config File Reference

### `project`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | — | Project name (optional label) |
| `monorepo` | boolean | `false` | Whether this is a monorepo |

### `scan`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `include` | string[] | `["src/**/*.ts", "src/**/*.tsx"]` | Glob patterns for files to include |
| `exclude` | string[] | `["node_modules/**", "dist/**", "**/*.test.ts", "**/*.spec.ts"]` | Glob patterns for files to exclude |

### `coverage`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable coverage analysis |
| `command` | string | `"npx vitest run --coverage.reporter=json"` | Shell command to generate coverage |
| `report_path` | string | `"coverage/coverage-final.json"` | Path to the JSON coverage report |

### `llm`

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `model` | string | `"claude-sonnet-4-6"` | — | Primary model for axis evaluations |
| `index_model` | string | `"claude-haiku-4-5-20251001"` | — | Model for RAG card generation |
| `fast_model` | string | — | — | Optional cheaper model for fast-tier (triaged) reviews |
| `agentic_tools` | boolean | `true` | — | Enable agentic tool use during evaluation |
| `timeout_per_file` | integer | `600` | ≥ 1 | Timeout in seconds per file evaluation |
| `max_retries` | integer | `3` | 1–10 | Max retry attempts for failed reviews |
| `concurrency` | integer | `4` | 1–10 | Number of parallel reviews |
| `min_confidence` | integer | `70` | 0–100 | Minimum confidence to report findings (hook mode) |
| `max_stop_iterations` | integer | `3` | 1–10 | Anti-loop limit for the stop hook |
| `deliberation` | boolean | `false` | — | Enable Opus deliberation pass after axis merge |
| `deliberation_model` | string | `"claude-opus-4-6"` | — | Model used for the deliberation pass |

### `llm.axes`

Per-axis overrides. Each axis accepts:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable this axis |
| `model` | string | — | Override the model for this axis only |

The 6 axes are: `correction`, `overengineering`, `utility`, `duplication`, `tests`, `best_practices`.

```yaml
llm:
  axes:
    duplication:
      enabled: false          # skip duplication analysis
    best_practices:
      model: "claude-opus-4-6"  # use Opus for best_practices only
```

### `rag`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable semantic RAG cross-file analysis. Disable with `--no-rag` or set to `false` |

### `badge`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Inject audit badge into README after run |
| `verdict` | boolean | `false` | Include audit verdict text in the badge |
| `link` | string (URL) | `"https://github.com/r-via/anatoly"` | URL the badge links to |

### `logging`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `level` | enum | `"warn"` | Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `file` | string | — | Path to a log file (ndjson format) |
| `pretty` | boolean | `true` | Pretty-print logs to stderr |

### `output`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_runs` | integer | — | Purge old runs beyond this limit |

---

## CLI Flags

### Global Flags

Available on all commands:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--config <path>` | string | — | Path to `.anatoly.yml` config file |
| `--verbose` | boolean | `false` | Enable verbose output (per-file time, cost, retries). Maps to `--log-level debug` |
| `--no-cache` | boolean | `false` | Skip SHA-256 cache, re-review all files |
| `--file <glob>` | string | — | Restrict scope to matching files (e.g. `"src/utils/**/*.ts"`) |
| `--plain` | boolean | `false` | Disable log-update, use linear sequential output |
| `--no-color` | boolean | `false` | Disable chalk colors (also respects `$NO_COLOR` env var) |
| `--no-rag` | boolean | `false` | Disable semantic RAG cross-file analysis |
| `--rebuild-rag` | boolean | `false` | Force full RAG re-indexation |
| `--open` | boolean | `false` | Open report in default app after generation |
| `--concurrency <n>` | integer | `4` | Number of concurrent reviews (1–10) |
| `--no-triage` | boolean | `false` | Disable triage, review all files with full agent |
| `--deliberation` | boolean | `false` | Enable Opus deliberation pass after axis merge |
| `--no-deliberation` | boolean | — | Disable deliberation pass (overrides config) |
| `--no-badge` | boolean | `false` | Skip README badge injection after audit |
| `--badge-verdict` | boolean | `false` | Include audit verdict in README badge |
| `--log-level <level>` | string | — | Set log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |
| `--log-file <path>` | string | — | Write structured logs to file (ndjson format) |

### Command-Specific Options

#### `run`

| Option | Type | Description |
|--------|------|-------------|
| `--run-id <id>` | string | Custom run ID (alphanumeric, dashes, underscores). Default: timestamp-based |

#### `report`

| Option | Type | Description |
|--------|------|-------------|
| `--run <id>` | string | Generate report from a specific run directory. Default: latest |

#### `clean-runs`

| Option | Type | Description |
|--------|------|-------------|
| `--keep <n>` | integer | Keep the N most recent runs, delete the rest |
| `-y, --yes` | boolean | Skip confirmation prompt (for CI/scripts) |

#### `reset`

| Option | Type | Description |
|--------|------|-------------|
| `-y, --yes` | boolean | Skip confirmation prompt (for CI/scripts) |

#### `rag-status [function]`

| Option | Type | Description |
|--------|------|-------------|
| `[function]` | string | Optional function name to inspect (shows similar functions) |
| `--all` | boolean | List all indexed function cards |
| `--json` | boolean | Output as JSON |

#### `hook init`

No options. Generates `.claude/settings.json` for Claude Code integration.

#### `hook post-edit` / `hook stop`

Internal commands invoked by Claude Code hooks. Not intended for direct use.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NO_COLOR` | Disable colored output (any value) |
| `ANATOLY_LOG_LEVEL` | Set log level. Overridden by `--log-level` CLI flag |

**Log level priority** (highest wins): `--log-level` flag → `--verbose` flag → `ANATOLY_LOG_LEVEL` env → config `logging.level` → default (`warn`)

---

## Review Output

Each reviewed file produces two outputs in `.anatoly/runs/<runId>/reviews/`:

**`.rev.json`** — Machine-readable, Zod-validated:

| Axis | Verdicts | Description |
|------|----------|-------------|
| `correction` | `OK` · `NEEDS_FIX` · `ERROR` | Syntax/semantic error detection |
| `overengineering` | `LEAN` · `OVER` · `ACCEPTABLE` | Over-engineering detection |
| `utility` | `USED` · `DEAD` · `LOW_VALUE` | Dead code / utility analysis |
| `duplication` | `UNIQUE` · `DUPLICATE` | Cross-file semantic duplication |
| `tests` | `GOOD` · `WEAK` · `NONE` | Test coverage analysis |
| `best_practices` | Score 0–10 (17 rules) + suggestions | Best practices scoring |
| `confidence` | 0–100 | Overall confidence of the review |

**`report.md`** — Sharded audit report:
- `report.md` — compact index (~100 lines) with executive summary, severity table, checkbox links to shards, and triage stats
- `report.N.md` — per-shard detail files (max 10 files each), sorted by severity with Quick Wins / Refactors / Hygiene actions

---

## Examples

### Minimal config

```yaml
# .anatoly.yml — defaults are fine for most projects
scan:
  include:
    - "src/**/*.ts"
```

### Monorepo with custom concurrency

```yaml
project:
  name: "my-monorepo"
  monorepo: true

scan:
  include:
    - "packages/*/src/**/*.ts"
  exclude:
    - "node_modules/**"
    - "dist/**"
    - "**/*.test.ts"

llm:
  concurrency: 8
```

### High-quality audit with deliberation

```yaml
llm:
  model: "claude-sonnet-4-6"
  deliberation: true
  deliberation_model: "claude-opus-4-6"
  axes:
    best_practices:
      model: "claude-opus-4-6"
```

### CI mode (no interactivity, file output)

```bash
anatoly run --no-badge --plain --no-color --log-file audit.ndjson
```

### Disable specific axes

```yaml
llm:
  axes:
    duplication:
      enabled: false
    tests:
      enabled: false
```

---

See also: [Logging](logging.md) · [How It Works](how-it-works.md) · [Architecture](architecture.md)
