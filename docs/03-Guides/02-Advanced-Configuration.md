# Advanced Configuration

> Complete reference for all `.anatoly.yml` options, CLI overrides, and environment variables that control Anatoly's audit behavior.

## Overview

Anatoly reads configuration from a `.anatoly.yml` file at the project root. If no file exists, all values fall back to schema defaults defined in `src/schemas/config.ts`. The file is loaded by `loadConfig()` in `src/utils/config-loader.ts`, parsed with `js-yaml`, and validated against `ConfigSchema` (Zod). A malformed YAML file or an invalid field value throws an `AnatolyError` with code `CONFIG_INVALID`.

Generate a fully commented template with every default pre-filled by running:

```bash
anatoly init
```

Use `--force` to overwrite an existing file:

```bash
anatoly init --force
```

The `--config <path>` global flag loads an alternate file instead of the project-root default:

```bash
anatoly run --config ./configs/anatoly.ci.yml
```

## Schema Reference

### `project`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | `string` | — | Display name for the project |
| `monorepo` | `boolean` | `false` | Enables monorepo-aware scanning |

---

### `scan`

Controls which files are included in each audit run.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `include` | `string[]` | `['src/**/*.ts', 'src/**/*.tsx']` | Glob patterns for files to audit |
| `exclude` | `string[]` | `['node_modules/**', 'dist/**', '**/*.test.ts', '**/*.spec.ts']` | Glob patterns to exclude |
| `auto_detect` | `boolean` | `true` | Auto-detect framework and language per file |

The `--file <glob>` CLI flag narrows the scan scope at runtime without modifying `.anatoly.yml`.

---

### `coverage`

When enabled, Anatoly runs the configured command to produce a JSON coverage report, then attaches coverage data to each file's review task.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable coverage integration |
| `command` | `string` | `'npx vitest run --coverage.reporter=json'` | Shell command that generates the report |
| `report_path` | `string` | `'coverage/coverage-final.json'` | Path to the JSON coverage output |

---

### `llm`

Controls the language model selection and agent behavior.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | `string` | `'claude-sonnet-4-6'` | Primary model for file audits |
| `index_model` | `string` | `'claude-haiku-4-5-20251001'` | Model used for RAG indexing summaries |
| `fast_model` | `string` | — | Optional override for triage and fast tasks |
| `agentic_tools` | `boolean` | `true` | Permit agent tool use during review |
| `timeout_per_file` | `integer ≥ 1` | `600` | Seconds before a single file review times out |
| `max_retries` | `integer 1–10` | `3` | Retry count per file on transient errors |
| `concurrency` | `integer 1–10` | `4` | Number of parallel file reviews |
| `sdk_concurrency` | `integer 1–20` | `8` | Maximum concurrent SDK calls |
| `min_confidence` | `integer 0–100` | `70` | Minimum confidence score for a finding to be reported |
| `max_stop_iterations` | `integer 1–10` | `3` | Maximum agent loop iterations before a forced stop |
| `deliberation` | `boolean` | `true` | Run an Opus deliberation pass after axis merge |
| `deliberation_model` | `string` | `'claude-opus-4-6'` | Model used for the deliberation pass |

#### `llm.axes`

Each axis can be individually enabled or disabled, and optionally overridden with a specific model.

| Axis | Default |
|------|---------|
| `utility` | `enabled: true` |
| `duplication` | `enabled: true` |
| `correction` | `enabled: true` |
| `overengineering` | `enabled: true` |
| `tests` | `enabled: true` |
| `best_practices` | `enabled: true` |
| `documentation` | `enabled: true` |

```yaml
llm:
  axes:
    correction:
      enabled: true
      model: claude-opus-4-6   # optional per-axis model override
    documentation:
      enabled: false
```

---

### `rag`

Controls the semantic RAG index used for cross-file analysis. RAG mode (lite vs. advanced) is auto-detected from hardware and can be forced with `--rag-lite` or `--rag-advanced`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable RAG cross-file analysis |
| `code_model` | `string` | `'auto'` | Embedding model for code vectors; `'auto'` selects the best available model for the detected hardware |
| `nlp_model` | `string` | `'auto'` | NLP embedding model for lite mode; `'auto'` resolves to `all-MiniLM-L6-v2` |
| `code_weight` | `number 0–1` | `0.6` | Weight for code similarity in hybrid search; NLP weight = `1 − code_weight` |

Advanced RAG mode requires Docker with the NVIDIA container toolkit.

---

### `logging`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `level` | `'fatal' \| 'error' \| 'warn' \| 'info' \| 'debug' \| 'trace'` | `'warn'` | Minimum level written to stderr |
| `file` | `string` | — | Optional path to write structured ndjson logs |
| `pretty` | `boolean` | `true` | Pretty-print when stderr is a TTY |

---

### `output`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `max_runs` | `integer ≥ 1` | — | Maximum number of runs to retain under `.anatoly/runs/` |

---

### `badge`

Controls README badge injection after a completed audit.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Inject or update the badge in `README.md` |
| `verdict` | `boolean` | `false` | Include the audit verdict text inside the badge |
| `link` | `string (URL)` | `'https://github.com/r-via/anatoly'` | URL the badge links to |

---

### `documentation`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `docs_path` | `string` | `'docs'` | Directory scanned for documentation files during RAG indexing |
| `module_mapping` | `Record<string, string[]>` | — | Maps module names to their associated documentation file paths |

## Examples

### Minimal production config

```yaml
# .anatoly.yml
project:
  name: my-api

scan:
  include:
    - src/**/*.ts
  exclude:
    - node_modules/**
    - dist/**
    - '**/*.test.ts'
    - '**/*.spec.ts'

llm:
  concurrency: 2
  deliberation: false

output:
  max_runs: 5

badge:
  enabled: false
```

### Full annotated config

```yaml
# .anatoly.yml — all fields with defaults shown
project:
  name: my-service
  monorepo: false

scan:
  include:
    - src/**/*.ts
    - src/**/*.tsx
  exclude:
    - node_modules/**
    - dist/**
    - '**/*.test.ts'
    - '**/*.spec.ts'
  auto_detect: true

coverage:
  enabled: true
  command: npx vitest run --coverage.reporter=json
  report_path: coverage/coverage-final.json

llm:
  model: claude-sonnet-4-6
  index_model: claude-haiku-4-5-20251001
  agentic_tools: true
  timeout_per_file: 600
  max_retries: 3
  concurrency: 4
  sdk_concurrency: 8
  min_confidence: 70
  max_stop_iterations: 3
  deliberation: true
  deliberation_model: claude-opus-4-6
  axes:
    utility:      { enabled: true }
    duplication:  { enabled: true }
    correction:   { enabled: true }
    overengineering: { enabled: true }
    tests:        { enabled: true }
    best_practices: { enabled: true }
    documentation: { enabled: true }

rag:
  enabled: true
  code_model: auto
  nlp_model: auto
  code_weight: 0.6

logging:
  level: warn
  file: .anatoly/anatoly.ndjson
  pretty: true

output:
  max_runs: 10

badge:
  enabled: true
  verdict: false
  link: https://github.com/r-via/anatoly

documentation:
  docs_path: docs
  module_mapping:
    auth:
      - docs/auth/overview.md
      - docs/auth/jwt.md
```

## CLI Flags that Override Config

The following flags override config values at runtime without modifying `.anatoly.yml`.

| Flag | Config equivalent |
|------|-------------------|
| `--config <path>` | loads alternate config file |
| `--concurrency <n>` | `llm.concurrency` |
| `--sdk-concurrency <n>` | `llm.sdk_concurrency` |
| `--no-rag` | `rag.enabled = false` |
| `--rag-lite` | forces lite RAG mode |
| `--rag-advanced` | forces advanced RAG mode |
| `--rebuild-rag` | forces full RAG re-indexation |
| `--code-model <model>` | `rag.code_model` |
| `--nlp-model <model>` | `rag.nlp_model` |
| `--no-triage` | disables the triage pass entirely |
| `--deliberation` | `llm.deliberation = true` |
| `--no-deliberation` | `llm.deliberation = false` |
| `--no-badge` | `badge.enabled = false` |
| `--badge-verdict` | `badge.verdict = true` |
| `--no-cache` | bypasses the SHA-256 file cache |
| `--file <glob>` | restricts scan scope to matching files |
| `--log-level <level>` | `logging.level` |
| `--log-file <path>` | `logging.file` |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Authentication for the Claude API. Required for all audit commands. |
| `ANATOLY_LOG_LEVEL` | Sets the log level when `--log-level` and `--verbose` are absent. Accepts the same values as `logging.level`. |
| `NO_COLOR` | When set to any value, disables all chalk color output ([no-color.org](https://no-color.org)). |

### Log Level Resolution Priority

`resolveLogLevel()` (`src/utils/logger.ts`) resolves the effective log level using the following priority (highest first):

1. `--log-level <level>` CLI flag
2. `--verbose` flag → maps to `debug`
3. `ANATOLY_LOG_LEVEL` environment variable
4. Default: `warn`

## See Also

- [02-Configuration](../01-Getting-Started/02-Configuration.md) — Initial setup and first config file
- [02-Global-Options](../03-CLI-Reference/02-Global-Options.md) — Full list of CLI flags
- [run command](../03-CLI-Reference/06-run.md) — Per-run flags and dry-run mode
- [init command](../03-CLI-Reference/16-init.md) — Generate a config template
