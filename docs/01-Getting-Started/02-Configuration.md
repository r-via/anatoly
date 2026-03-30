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
  dual_embedding: true      # Dual code+NLP embedding (auto-disabled when nomic-embed-code GGUF container is active)
  code_model: auto          # Code embedding model ('auto' = nomic-embed-code via Docker GGUF if GPU, else Jina ONNX)
  nlp_model: auto           # NLP embedding model ('auto' = Qwen3-Embedding-8B via Docker GGUF, else all-MiniLM-L6-v2 ONNX)
  code_weight: 0.6          # Hybrid search weighting (0-1, only used in dual mode)

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

The seven axes are: `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices`, `documentation`.

### documentation

Configuration for the documentation evaluation axis.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `docs_path` | string | `"docs"` | Path to the project documentation directory (relative to project root) |
| `module_mapping` | object | *(none)* | Map source directories to documentation pages for concept coverage |

Example with module mapping:

```yaml
documentation:
  docs_path: docs
  module_mapping:
    src/core/scanner.ts:
      - docs/02-Architecture/01-Pipeline-Overview.md
    src/core/axes:
      - docs/04-Core-Modules/04-Axis-Evaluators.md
```

When `module_mapping` is not configured, the docs-resolver falls back to directory name convention matching (e.g., `src/core/` matches `docs/**/core*.md`). Up to 3 documentation pages (max 300 lines each) are resolved per file.

When no `/docs/` directory exists, only JSDoc inline evaluation is performed (graceful degradation).

### rag

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable local RAG indexing and semantic search |
| `dual_embedding` | boolean | `true` | Dual code+NLP embedding. Auto-disabled when nomic-embed-code GGUF container is active (encodes code + semantics natively) |
| `code_model` | string | `"auto"` | Code embedding model. `auto` selects nomic-embed-code (Docker GGUF, 3584d) if GPU available, otherwise Jina v2 (ONNX, 768d) |
| `nlp_model` | string | `"auto"` | NLP embedding model (only used in dual mode). `auto` selects Qwen3-Embedding-8B (Docker GGUF, 4096d) if GPU available, otherwise all-MiniLM-L6-v2 (ONNX, 384d) |
| `code_weight` | number | `0.6` | Hybrid search weighting (only used in dual mode). Higher = more weight on code similarity |

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

## Project instructions (`ANATOLY.md`)

Drop an `ANATOLY.md` file at the root of your project to tell Anatoly about your conventions. No configuration needed -- the file is detected automatically on every `anatoly run`.

### Format

Use `## H2` headings to target specific axes. Content under `## General` is prepended to every axis.

```markdown
# My Project Instructions

## General
This is an ESM-only Node.js project with strict TypeScript.

## Documentation
- We do NOT use JSDoc -- TypeScript types are the documentation.
- Every module > 100 lines must have a descriptive header comment.

## Best Practices
- No barrel files (index.ts re-exports) -- direct imports only.
- Zod is required for all external input validation.

## Correction
- Race conditions on background workers are known and accepted (ignore).

## Tests
- Every endpoint must have a supertest integration test.
- Expected minimum coverage: 80% on services.

## Utility
- Exports in src/legacy/ are intentionally unused (migration in progress).

## Overengineering
- The factory pattern in src/providers/ is intentional (not over-engineered).

## Duplication
- Similar validation logic across controllers is accepted (no shared abstraction).
```

### Recognized sections

| H2 heading | Target axis | Effect |
|------------|-------------|--------|
| `General` | All axes | Content prepended to every axis |
| `Correction` | `correction` | Calibrate error/fix detection |
| `Utility` | `utility` | Calibrate dead code detection |
| `Duplication` | `duplication` | Calibrate duplicate detection |
| `Overengineering` | `overengineering` | Calibrate complexity detection |
| `Tests` | `tests` | Calibrate test coverage evaluation |
| `Best Practices` | `best_practices` | Calibrate coding standards evaluation |
| `Documentation` | `documentation` | Calibrate documentation evaluation |

Section headings are case-insensitive: `## CORRECTION`, `## correction`, and `## Correction` all work. Unrecognized sections (e.g., `## Deployment`) are silently ignored.

### How calibration works

Your instructions neither override nor replace the standard evaluation rules. They **calibrate** the LLM's judgment:

- If you say "we don't use JSDoc", then absence of JSDoc is not a finding -- but other documentation aspects (header comments, README coverage) are still evaluated.
- If you add a stricter rule (e.g., "Zod required for all inputs"), it becomes an additional criterion on top of the standard rules.
- If you say nothing about an axis, it evaluates with the default rules unchanged.

### Section length warning

Keep each section concise. Sections exceeding ~2000 tokens (~8000 characters) trigger a warning:

```
ANATOLY.md section "best_practices" is very long (~2500 tokens). Long sections may dilute scoring accuracy.
```

Shorter, focused instructions produce better calibration than exhaustive rulebooks.

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
