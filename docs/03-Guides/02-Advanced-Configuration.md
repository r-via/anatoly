# Advanced Configuration

> Complete reference for all `.anatoly.yml` options (schema v2), CLI overrides, and environment variables that control Anatoly's audit behavior.

## Overview

Anatoly reads configuration from a `.anatoly.yml` file at the project root. If no file exists, all values fall back to schema defaults defined in [src/schemas/config.ts](../../src/schemas/config.ts). The file is loaded by `loadConfig()` in [src/utils/config-loader.ts](../../src/utils/config-loader.ts), parsed with `js-yaml`, and validated against `ConfigSchema` (Zod). A malformed YAML file or an invalid field value throws an `AnatolyError` with code `CONFIG_INVALID`.

Generate a commented template interactively via:

```bash
anatoly init
```

Use `--force` to overwrite an existing file.

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
| `include` | `string[]` | `[]` | Glob patterns for files to audit. Authoritative — anatoly does not silently augment this list and does not assume a language. The first-run wizard emits a starter appropriate to the detected project. To scan additional languages, add their patterns explicitly (e.g. `'**/*.py'`, `'**/*.go'`). |
| `exclude` | `string[]` | `['node_modules/**', 'dist/**']` | Glob patterns to exclude from `include` matches. Defaults are minimal and Node-leaning. Add per-language test/build patterns yourself (e.g. `'**/*.test.ts'`, `'target/**'`). |

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

### `providers` (v2)

Declares one or more LLM providers. Each provider entry configures its transport mode (subscription-based CLI vs. direct API), concurrency ceiling, and — for OpenAI-compatible providers — the `base_url` and `env_key`.

At least one provider must be configured. `anthropic` is present by default (`mode: subscription`, `concurrency: 24`).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | `'subscription' \| 'api'` | `'api'` (`'subscription'` for `anthropic` and `google`) | Transport mode for all calls |
| `concurrency` | `integer 1–32` | `8` (`24` for anthropic, `10` for google) | Max concurrent in-flight calls to this provider |
| `single_turn` | `'subscription' \| 'api'` | — | Override transport for single-turn (axis) calls |
| `agents` | `'subscription' \| 'api'` | — | Override transport for agentic (multi-turn tool-use) calls |
| `base_url` | `string` | — (from registry for known providers) | Base URL for OpenAI-compatible providers |
| `env_key` | `string` | — (from registry for known providers) | Name of the env var holding the API key |

**Known providers** (see [src/core/providers/known-providers.ts](../../src/core/providers/known-providers.ts)):

| Provider | Default `env_key` | Default `base_url` | Transport |
|----------|-------------------|--------------------|-----------|
| `anthropic` | `ANTHROPIC_API_KEY` | — | native |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | — | native |
| `openai` | `OPENAI_API_KEY` | — | native |
| `qwen` | `DASHSCOPE_API_KEY` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | openai-compatible |
| `groq` | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | openai-compatible |
| `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | openai-compatible |
| `mistral` | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` | openai-compatible |
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | openai-compatible |
| `ollama` | `OLLAMA_API_KEY` | `http://localhost:11434/v1` | openai-compatible |

Unknown providers are accepted as long as they supply a `base_url` (they are treated as openai-compatible).

```yaml
providers:
  anthropic:
    mode: subscription
    concurrency: 24
  google:
    mode: api
    concurrency: 10
```

---

### `models` (v2)

Selects the concrete model used for each pipeline role. Model strings use `provider/model-id` form (e.g. `anthropic/claude-sonnet-4-6`, `google/gemini-2.5-flash-lite`).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `quality` | `string` | `'anthropic/claude-sonnet-4-6'` | Primary model for axis evaluations |
| `fast` | `string` | `'anthropic/claude-haiku-4-5-20251001'` | Fast model for triage and fallback code summaries |
| `deliberation` | `string` | `'anthropic/claude-opus-4-6'` | Model used for the tier-3 deliberation pass |
| `code_summary` | `string` | — (falls back to `models.fast`) | Model used for per-file code summaries during RAG indexing |

`code_summary` is typically pointed at a cheap/fast non-Claude model (e.g. `google/gemini-2.5-flash-lite`) to offload the Claude quota — it is invoked once per indexed file. When unset, `models.fast` (Haiku) is used.

---

### `agents` (v2)

Controls agentic (multi-turn tool-use) behavior.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable agentic tool use during review |
| `scaffolding` | `string` | — | Optional model override for scaffolding agents |
| `review` | `string` | — | Optional model override for review agents |
| `deliberation` | `string` | — | Optional model override for the deliberation agent |
| `max_turns` | `integer 1–200` | `30` | Maximum agentic turns per multi-turn query (tier 3, doc generation) |

---

### `runtime` (v2)

Audit-pipeline runtime limits. These replace the former `llm.*` timing/retry fields from schema v1.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `timeout_per_file` | `integer ≥ 1` | `600` | Seconds before a single file review times out |
| `max_retries` | `integer 1–10` | `3` | Retry count per file on transient errors |
| `concurrency` | `integer 1–10` | `8` | Number of parallel file reviews |
| `min_confidence` | `integer 0–100` | `70` | Minimum confidence score for a finding to be reported |
| `max_stop_iterations` | `integer 1–10` | `3` | Maximum agent loop iterations before a forced stop |

Per-provider SDK concurrency is controlled by `providers.<id>.concurrency` (not a global `runtime` field).

---

### `axes` (v2, top-level)

Each axis can be individually enabled or disabled, optionally overridden with a specific model, and optionally skipped for matching file globs.

| Axis | Default |
|------|---------|
| `utility` | `enabled: true` |
| `duplication` | `enabled: true` |
| `correction` | `enabled: true` |
| `overengineering` | `enabled: true` |
| `tests` | `enabled: true` |
| `best_practices` | `enabled: true` |
| `documentation` | `enabled: true` |

Each axis entry accepts:

| Key | Type | Description |
|-----|------|-------------|
| `enabled` | `boolean` | Whether the axis runs |
| `model` | `string` | Optional model override (e.g. `google/gemini-2.5-flash`). Ignored if its provider is not configured. |
| `skip` | `string[]` | Glob patterns (relative paths) to skip for this axis |

```yaml
axes:
  correction:
    enabled: true
    model: anthropic/claude-opus-4-6
  documentation:
    enabled: false
  tests:
    skip:
      - src/generated/**
```

The axis-to-model resolution is defined in `resolveAxisModel()` ([src/core/axis-evaluator.ts](../../src/core/axis-evaluator.ts)): per-axis `model` → else `models.fast` or `models.quality` based on the evaluator's default tier.

---

### `rag`

Controls the semantic RAG index used for cross-file analysis. RAG mode (lite vs. advanced) is auto-detected from hardware and can be forced with `--rag-lite` or `--rag-advanced`. The `external` mode (third-party provider) is selected by setting `rag.embedding`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable RAG cross-file analysis |
| `code_model` | `string` | `'auto'` | Embedding model for code vectors (lite/advanced tiers); `'auto'` selects the best available model for the detected hardware |
| `nlp_model` | `string` | `'auto'` | NLP embedding model for lite mode; `'auto'` resolves to `all-MiniLM-L6-v2` |
| `code_weight` | `number 0–1` | `0.6` | Weight for code similarity in hybrid search; NLP weight = `1 − code_weight` |
| `embedding` | `{ code?: ProviderConfig, nlp?: ProviderConfig }` | absent | Third-party embedding provider configuration, split per axis. See [Embedding Providers guide](./03-Embedding-Providers.md). |

Each `ProviderConfig` is `{ provider: string, model?: string, base_url?: string, env_key?: string }`. Either or both axes may be set; if only one is set the other duplicates it at runtime. When `rag.embedding` is absent, Anatoly falls back to lite or advanced based on hardware detection.

Advanced RAG mode requires Docker with the NVIDIA container toolkit. External mode requires only an HTTPS-reachable provider endpoint and the corresponding API key (e.g. `OPENAI_API_KEY`, `VOYAGE_API_KEY`).

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

Anatoly distinguishes two documentation registers: **reference** (human-authored: READMEs, specs, doc-comments) and **internal** (curated from code by Anatoly itself, full mode only). The wizard (`anatoly init`) writes both blocks explicitly.

```yaml
documentation:
  reference:
    paths: ['README.md', 'docs/**/*.md']
    inline_comments:
      enabled: true
      kinds: ['jsdoc', 'tsdoc']
      include: ['src/**/*.ts']
  internal:
    mode: 'lite'                # 'lite' | 'full' | 'off'
    # full:                     # only present when mode: full
    #   sync_to_repo: false
```

#### `documentation.reference`

Human-authored docs treated as ground truth by the review axes.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `paths` | `string[]` | (required, ≥ 1) | Globs pointing to Markdown reference docs (READMEs, specs, guides). Paths must be relative to the project root. Indexed verbatim into the RAG store (root-level files like `README.md` included). |
| `inline_comments.enabled` | `boolean` | (required) | Opt-in extraction of structured doc-comments (JSDoc, Godoc, etc.) attached to exported symbols. |
| `inline_comments.kinds` | `string[]` | (required when enabled) | Doc-comment dialects to extract: `jsdoc`, `tsdoc`, `docstring`, `godoc`, `javadoc`, `xmldoc`, `module_header`. |
| `inline_comments.include` | `string[]` | (required when enabled) | Source-file globs to scan for doc-comments. |
| `module_mapping` | `Record<string, string[]>` | (optional) | Map from doc page name (key) to source module globs (values) the page covers. Used by the documentation axis. |

#### `documentation.internal.mode`

Selects how reference documentation reaches the business-logic axes (`correction`, `best-practices`, `overengineering`). **No default**: the wizard pre-checks `lite` but the field must be present in the YAML.

| Mode | Sub-config | What it does |
|------|-----------|--------------|
| `lite` | none | Per-file RAG retrieval. For each file under review, Anatoly queries the doc-section vector index for the most relevant chunks of your reference docs, expands each to its H2 neighbourhood, and injects them as authoritative ground truth. No LLM, no upfront artefact, no token budget to tune. |
| `full` | `full.sync_to_repo` | LLM-curated internal docs under `.anatoly/state/internal-docs/`, plus a 3-way coherence + arbitration pass (see below). |
| `off` | none | No reference docs injected at all. Code-only audit. |

##### lite vs full: the key difference is arbitration

This is the distinction that matters when choosing a mode.

**`lite` assumes your reference docs are correct and current.** The retrieved doc chunks are injected as ground truth with no reconciliation step. If the code contradicts the docs, that contradiction is flagged as a `doc_divergence` finding against the **code** (the doc wins by assumption). Choose `lite` when your docs are actively maintained and you trust them to describe intended behaviour. It is deterministic (cosine similarity, no LLM), cheap, and scales to any doc corpus size because retrieval is per-file rather than whole-corpus.

**`full` does not assume the docs are correct.** It generates internal per-module documentation from the code, then runs a 3-way coherence pass that arbitrates between three sources:

1. **Reference docs** (what humans wrote)
2. **Internal docs** (what Anatoly derived from the code)
3. **Code surface** (the actual symbols and signatures)

When reference and code diverge, full mode does not silently pick a winner: it produces `doc_divergence` findings describing the conflict, and the internal docs are rewritten only to fill gaps the reference docs leave open (never to overrule what the reference docs explicitly state). Curated fragments a human validates via `anatoly docs arbitrate` are promoted to authoritative "arbitrated intents" and injected alongside the reference docs. Choose `full` when your docs may be stale or incomplete and you want Anatoly to surface code/doc drift rather than trust the docs blindly.

| | `lite` | `full` |
|---|---|---|
| Doc context delivery | per-file RAG retrieval | LLM-curated pages + arbitrated fragments |
| Reference docs treated as | authoritative ground truth (trusted) | one of three arbitrated sources |
| Code/doc drift | flagged as `doc_divergence` (doc wins) | arbitrated; gaps filled, conflicts surfaced |
| LLM cost at doc stage | none | scaffold + generation + coherence |
| Determinism | full (cosine similarity) | LLM-driven |
| Scales with doc size | yes (per-file) | yes (per-module curation) |
| Artefact on disk | none | `.anatoly/state/internal-docs/*.md` |

#### `documentation.internal.full`

Required when `mode: full`. Omitted entirely for `lite` and `off`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sync_to_repo` | `boolean` | (required) | Reserved for backwards compatibility. The implicit `.anatoly/state/internal-docs/ → docs/` sync was removed in epic-54. If you want to commit the curated docs, copy them manually (`cp -r .anatoly/state/internal-docs docs`). |

> Observability: every RAG retrieval (lite mode per-file lookups, duplication-axis symbol searches, documentation-axis lookups) emits a structured `rag.query` event into `.anatoly/runs/<runId>/anatoly.ndjson` with the caller, file, query parameters, latency, and top hit. Grep `rag_query` to follow the full retrieval chain of any run.

---

### `search`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | `'exa' \| 'brave'` | — | Optional web-search provider used by agentic tools |

---

### `notifications.telegram`

Optional Telegram notifications at run completion.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable Telegram notifications |
| `username` | `string` | — | Telegram username (without `@`). Resolved to `chat_id` automatically. |
| `chat_id` | `string` | — | Telegram chat ID (channel, group, or user) |
| `bot_token_env` | `string` | `'ANATOLY_TELEGRAM_BOT_TOKEN'` | Env var holding the bot token. Never store tokens in YAML. |
| `report_url` | `string (URL)` | — | Optional URL to the published report, appended to the message |

When `enabled: true`, either `chat_id` or `username` is required.

---

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

providers:
  anthropic:
    mode: subscription

runtime:
  concurrency: 2

output:
  max_runs: 5

badge:
  enabled: false
```

### Dual-provider config (Anthropic + Gemini for summaries)

```yaml
# .anatoly.yml
project:
  name: my-service

providers:
  anthropic:
    mode: subscription
    concurrency: 24
  google:
    mode: api
    concurrency: 10
    env_key: GOOGLE_GENERATIVE_AI_API_KEY

models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5-20251001
  deliberation: anthropic/claude-opus-4-6
  code_summary: google/gemini-2.5-flash-lite

axes:
  correction:
    model: anthropic/claude-opus-4-6
  duplication:
    model: google/gemini-2.5-flash
```

### Full annotated config

```yaml
# .anatoly.yml — all sections with defaults shown
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

coverage:
  enabled: true
  command: npx vitest run --coverage.reporter=json
  report_path: coverage/coverage-final.json

providers:
  anthropic:
    mode: subscription
    concurrency: 24

models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5-20251001
  deliberation: anthropic/claude-opus-4-6
  # code_summary: google/gemini-2.5-flash-lite   # optional — offloads RAG summaries off the Claude quota

agents:
  enabled: true
  max_turns: 30

runtime:
  timeout_per_file: 600
  max_retries: 3
  concurrency: 8
  min_confidence: 70
  max_stop_iterations: 3

axes:
  utility:         { enabled: true }
  duplication:     { enabled: true }
  correction:      { enabled: true }
  overengineering: { enabled: true }
  tests:           { enabled: true }
  best_practices:  { enabled: true }
  documentation:   { enabled: true }

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

search:
  provider: exa

notifications:
  telegram:
    enabled: false
    username: myhandle
    bot_token_env: ANATOLY_TELEGRAM_BOT_TOKEN
```

---

## CLI Flags that Override Config

The following flags override config values at runtime without modifying `.anatoly.yml`.

| Flag | Config equivalent |
|------|-------------------|
| `--config <path>` | loads alternate config file |
| `--concurrency <n>` | `runtime.concurrency` |
| `--sdk-concurrency <n>` | `providers.<id>.concurrency` (applied to the active provider) |
| `--no-rag` | `rag.enabled = false` |
| `--rag-lite` | forces lite RAG mode |
| `--rag-advanced` | forces advanced RAG mode |
| `--rebuild-rag` | forces full RAG re-indexation |
| `--code-model <model>` | `rag.code_model` |
| `--nlp-model <model>` | `rag.nlp_model` |
| `--no-triage` | disables the triage pass entirely |
| `--deliberation` / `--no-deliberation` | toggles the Opus deliberation pass |
| `--no-badge` | `badge.enabled = false` |
| `--badge-verdict` | `badge.verdict = true` |
| `--no-cache` | bypasses the SHA-256 file cache |
| `--file <glob>` | restricts scan scope to matching files |
| `--axes <list>` | restricts the run to a comma-separated subset of axes |
| `--flush-memory` | clears deliberation memory before running |
| `--dry-run` | simulates the run (scan + estimate + triage only) |
| `--log-level <level>` | `logging.level` |
| `--log-file <path>` | `logging.file` |
| `--verbose` | forces `logging.level = debug` |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Authentication for the Claude API when `providers.anthropic.mode: api`. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Authentication for Gemini when `providers.google` is configured in `api` mode. |
| `OPENAI_API_KEY`, `GROQ_API_KEY`, `DASHSCOPE_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY` | Provider API keys for the corresponding registry entry. Override the env var name with `providers.<id>.env_key`. |
| `ANATOLY_TELEGRAM_BOT_TOKEN` | Default env var read when `notifications.telegram.enabled: true`. Rename via `bot_token_env`. |
| `ANATOLY_LOG_LEVEL` | Sets the log level when `--log-level` and `--verbose` are absent. Accepts the same values as `logging.level`. |
| `NO_COLOR` | When set to any value, disables all chalk color output ([no-color.org](https://no-color.org)). |

### Log Level Resolution Priority

`resolveLogLevel()` ([src/utils/logger.ts](../../src/utils/logger.ts)) resolves the effective log level using the following priority (highest first):

1. `--log-level <level>` CLI flag
2. `--verbose` flag → maps to `debug`
3. `ANATOLY_LOG_LEVEL` environment variable
4. Default: `warn`

---

## See Also

- [02-Configuration](../01-Getting-Started/02-Configuration.md) — Initial setup and first config file
- [02-Global-Options](../03-CLI-Reference/02-Global-Options.md) — Full list of CLI flags
- [run command](../03-CLI-Reference/06-run.md) — Per-run flags and dry-run mode
- [init command](../03-CLI-Reference/16-init.md) — Generate a config template
