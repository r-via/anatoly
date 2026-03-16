# Configuration

Anatoly is configured via a `.anatoly.yml` file in your project root. Every field is optional -- if the file does not exist or is empty, Anatoly uses sensible defaults.

## Full reference

```yaml
# .anatoly.yml

project:
  name: "my-project"       # Optional project name
  monorepo: false           # Set to true for monorepo support

scan:
  include:                  # Glob patterns for files to scan
    - "src/**/*.ts"
    - "src/**/*.tsx"
  exclude:                  # Glob patterns for files to skip
    - "node_modules/**"
    - "dist/**"
    - "**/*.test.ts"
    - "**/*.spec.ts"

coverage:
  enabled: true
  command: "npx vitest run --coverage.reporter=json"
  report_path: "coverage/coverage-final.json"

llm:
  model: "claude-sonnet-4-6"              # Primary review model
  index_model: "claude-haiku-4-5-20251001"  # Model for indexing tasks
  fast_model: ~                            # Optional fast model override
  agentic_tools: true                      # Enable agent tool use (grep, read, RAG query)
  timeout_per_file: 600                    # Seconds before a file review times out
  max_retries: 3                           # Retries per file on transient errors (1-10)
  concurrency: 4                           # Parallel file reviews (1-10)
  min_confidence: 70                       # Minimum confidence threshold (0-100)
  max_stop_iterations: 3                   # Max stop iterations per review (1-10)
  deliberation: false                      # Enable Opus deliberation pass
  deliberation_model: "claude-opus-4-6"    # Model for deliberation pass

  axes:
    utility:
      enabled: true
      model: ~              # Override model for this axis
    duplication:
      enabled: true
    correction:
      enabled: true
    overengineering:
      enabled: true
    tests:
      enabled: true
    best_practices:
      enabled: true

rag:
  enabled: true             # Enable semantic RAG cross-file analysis
  dual_embedding: false     # Enable dual code+NLP embedding for hybrid search
  code_model: auto          # Code embedding model ('auto' = best available: sentence-transformers sidecar or Jina ONNX)
  nlp_model: auto           # NLP embedding model ('auto' = all-MiniLM-L6-v2 ONNX)
  code_weight: 0.6          # Hybrid search weighting (0-1, default: 0.6 = 60% code, 40% NLP)

logging:
  level: "warn"             # Log level: fatal, error, warn, info, debug, trace
  file: ~                   # Optional path to write ndjson logs
  pretty: true              # Pretty-print logs to terminal

output:
  max_runs: ~               # Auto-purge old runs, keeping N most recent

badge:
  enabled: true             # Inject "Checked by Anatoly" badge into README.md
  verdict: false            # Include audit verdict (CLEAN/FINDINGS) in badge
  link: "https://github.com/r-via/anatoly"
```

## Option reference

### project

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `name` | string | *(none)* | Optional project name for reports |
| `monorepo` | boolean | `false` | Enable monorepo scanning mode |

### scan

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `include` | string[] | `["src/**/*.ts", "src/**/*.tsx"]` | Glob patterns for files to scan |
| `exclude` | string[] | `["node_modules/**", "dist/**", "**/*.test.ts", "**/*.spec.ts"]` | Glob patterns to exclude |

### coverage

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable test coverage analysis |
| `command` | string | `"npx vitest run --coverage.reporter=json"` | Command to generate coverage report |
| `report_path` | string | `"coverage/coverage-final.json"` | Path to coverage JSON output |

### llm

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `"claude-sonnet-4-6"` | Primary model for file reviews |
| `index_model` | string | `"claude-haiku-4-5-20251001"` | Model for lightweight indexing tasks |
| `fast_model` | string | *(none)* | Optional fast model override |
| `agentic_tools` | boolean | `true` | Allow the agent to use grep, read, and RAG query tools |
| `timeout_per_file` | integer | `600` | Seconds before a single file review is aborted |
| `max_retries` | integer | `3` | Number of retries on transient errors (1-10) |
| `concurrency` | integer | `4` | Number of files reviewed in parallel (1-10) |
| `min_confidence` | integer | `70` | Findings below this confidence score (0-100) are filtered |
| `max_stop_iterations` | integer | `3` | Maximum stop iterations per review loop (1-10) |
| `deliberation` | boolean | `false` | Enable an Opus deliberation pass after axis merge |
| `deliberation_model` | string | `"claude-opus-4-6"` | Model used for the deliberation pass |

### llm.axes

Each axis can be individually toggled and assigned a model override.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Whether this axis runs during review |
| `model` | string | *(uses llm.model)* | Override the model for this specific axis |

The six axes are: `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices`.

### rag

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable local RAG indexing and semantic search |
| `dual_embedding` | boolean | `false` | Enable dual code+NLP embedding for hybrid search |
| `code_model` | string | `"auto"` | Code embedding model. `auto` selects Nomic Embed Code (sidecar) if GPU available, otherwise Jina v2 (ONNX) |
| `nlp_model` | string | `"auto"` | NLP embedding model. `auto` selects all-MiniLM-L6-v2 (ONNX) |
| `code_weight` | number | `0.6` | Hybrid search weighting (0-1). Higher = more weight on code similarity |

### logging

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `level` | enum | `"warn"` | Log verbosity: `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `file` | string | *(none)* | Write structured ndjson logs to this file path |
| `pretty` | boolean | `true` | Pretty-print logs in the terminal |

### output

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `max_runs` | integer | *(none)* | Automatically delete old runs, keeping the N most recent |

### badge

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Inject a "Checked by Anatoly" badge into README.md |
| `verdict` | boolean | `false` | Include audit verdict in the badge text |
| `link` | string | `"https://github.com/r-via/anatoly"` | URL the badge links to |

## Example configurations

### Small project (< 50 files)

Defaults work well. No config file needed. Or create a minimal one:

```yaml
# .anatoly.yml
llm:
  concurrency: 2
```

### Medium project (50-200 files)

```yaml
# .anatoly.yml
llm:
  concurrency: 4
  deliberation: true

output:
  max_runs: 5
```

### Large project (200+ files)

```yaml
# .anatoly.yml
scan:
  include:
    - "src/**/*.ts"
    - "src/**/*.tsx"
    - "lib/**/*.ts"
  exclude:
    - "node_modules/**"
    - "dist/**"
    - "**/*.test.ts"
    - "**/*.spec.ts"
    - "**/*.generated.ts"
    - "src/migrations/**"

llm:
  concurrency: 8
  deliberation: true
  timeout_per_file: 900

  axes:
    best_practices:
      enabled: false    # Skip for faster runs on large codebases

output:
  max_runs: 3
```

### CI pipeline

```yaml
# .anatoly.yml
llm:
  concurrency: 4
  deliberation: false   # Faster for CI

badge:
  enabled: false        # No README modification in CI

logging:
  level: "info"
  pretty: false         # Structured output for CI
```

## CLI flags

CLI flags override `.anatoly.yml` values for the current run.

### Global options

| Flag | Description |
|------|-------------|
| `--config <path>` | Path to a config file (default: `.anatoly.yml` in project root) |
| `--verbose` | Show detailed operation logs |
| `--no-cache` | Reset `CACHED` files to `PENDING` for re-review. Files that completed as `DONE` are only re-reviewed when their SHA-256 hash changes. |
| `--file <glob>` | Restrict scope to matching files |
| `--plain` | Disable animated output, use linear sequential output |
| `--no-color` | Disable chalk colors (also respects `$NO_COLOR` env var) |
| `--no-rag` | Disable semantic RAG cross-file analysis |
| `--rebuild-rag` | Force full RAG re-indexation |
| `--dual-embedding` | Enable dual code+NLP embedding (overrides config) |
| `--no-dual-embedding` | Disable dual embedding (overrides config) |
| `--code-model <model>` | Override code embedding model |
| `--nlp-model <model>` | Override NLP embedding model |
| `--open` | Open report in default app after generation |
| `--concurrency <n>` | Number of concurrent reviews (1-10) |
| `--no-triage` | Disable triage, review all files with full agent |
| `--deliberation` | Enable Opus deliberation pass after axis merge |
| `--no-deliberation` | Disable deliberation pass (overrides config) |
| `--no-badge` | Skip README badge injection after audit |
| `--badge-verdict` | Include audit verdict in README badge |
| `--log-level <level>` | Set log level (fatal, error, warn, info, debug, trace) |
| `--log-file <path>` | Write logs to file in ndjson format |

### Run command options

| Flag | Description |
|------|-------------|
| `--run-id <id>` | Custom run ID (alphanumeric, dashes, underscores). Default: `YYYY-MM-DD_HHmmss` |

## Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | The Claude Agent SDK reads this implicitly from the environment. The primary auth mechanism is having Claude Code installed and authenticated. |
| `ANATOLY_LOG_LEVEL` | Set log verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). Priority chain: `--log-level` flag > `--verbose` flag > `ANATOLY_LOG_LEVEL` env > config `logging.level` > default (`warn`). |
| `NO_COLOR` | When set (any value), disables all terminal colors. Follows the [no-color.org](https://no-color.org/) convention. |
