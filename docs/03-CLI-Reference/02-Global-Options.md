# Global Options

Global options are defined on the root `anatoly` program and inherited by all commands. They control configuration, output formatting, caching, RAG behavior, concurrency, and logging.

---

## Configuration

### --config \<path\>

Path to a custom `.anatoly.yml` configuration file. When omitted, Anatoly looks for `.anatoly.yml` in the project root.

| Property | Value |
|----------|-------|
| Type | string (file path) |
| Default | `.anatoly.yml` in project root |

```bash
anatoly run --config configs/strict.yml
```

---

## Scope

### --file \<glob\>

Restrict the audit scope to files matching a glob pattern. When used with `run`, matching files are always re-reviewed regardless of cache status (implicit `--no-cache` for those files).

| Property | Value |
|----------|-------|
| Type | string (glob pattern) |
| Default | all files matching `scan.include` |

```bash
anatoly run --file "src/core/**"
anatoly run --file "src/commands/run.ts"
anatoly estimate --file "src/rag/**"
```

---

## Output

### --verbose

Show detailed operation logs during scan, review, and other phases. Enables additional output lines such as file-level scan counts and retry messages.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `false` |

```bash
anatoly run --verbose
```

### --plain

Disable `listr2` animated output and use linear sequential logging instead. Automatically enabled when stdout is not a TTY.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `false` (animated when TTY, plain otherwise) |

```bash
anatoly run --plain
```

### --no-color

Disable chalk color output. Also respected via the `$NO_COLOR` environment variable per the [no-color.org](https://no-color.org/) convention.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `false` |

```bash
anatoly run --no-color
# or
NO_COLOR=1 anatoly run
```

### --open

Open the generated report in the system default application after report generation completes. Works with both `run` and `report` commands.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `false` |

```bash
anatoly run --open
anatoly report --open
```

---

## Cache

### --no-cache

Ignore SHA-256 file caches and force re-review of all files. By default, files whose hash matches the previous scan are skipped.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `false` (cache enabled) |

```bash
anatoly run --no-cache
```

---

## RAG

### --no-rag

Disable semantic RAG cross-file analysis entirely. The Duplication axis will not have access to the vector store for similarity search.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `false` (RAG enabled if `rag.enabled` is true in config) |

```bash
anatoly run --no-rag
```

### --rebuild-rag

Force a full RAG re-indexation, discarding the existing LanceDB vector store and re-embedding all function cards from scratch.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `false` |

```bash
anatoly run --rebuild-rag
```

---

## Triage

### --no-triage

Disable the triage phase and review all files with the full agent evaluator. By default, triage classifies files as `skip` (trivial, generated, or low-risk) or `evaluate` (requires full review), reducing API cost and wall-clock time.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `false` (triage enabled) |

```bash
anatoly run --no-triage
```

---

## Concurrency

### --concurrency \<n\>

Number of concurrent file reviews during the review phase. Must be an integer between 1 and 10. Overrides the `llm.concurrency` value from `.anatoly.yml`.

| Property | Value |
|----------|-------|
| Type | integer (1--10) |
| Default | `llm.concurrency` from config |

```bash
anatoly run --concurrency 6
```

---

## Deliberation

### --deliberation

Enable the Opus deliberation pass after axis merge. Uses the `llm.deliberation_model` from config to perform a final coherence check on the merged review.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `llm.deliberation` from config |

```bash
anatoly run --deliberation
```

### --no-deliberation

Disable the deliberation pass, overriding the config value even when `llm.deliberation` is `true`.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | follows config |

```bash
anatoly run --no-deliberation
```

---

## Badge

### --no-badge

Skip README badge injection after the audit completes. By default, Anatoly appends or updates a "Checked by Anatoly" shields.io badge in `README.md` when `badge.enabled` is true in config.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `false` (badge injection enabled if `badge.enabled` in config) |

```bash
anatoly run --no-badge
```

### --badge-verdict

Include the audit verdict (CLEAN, needs refactor, critical) in the README badge label and color-code it accordingly. Overrides `badge.verdict` from config.

| Property | Value |
|----------|-------|
| Type | boolean |
| Default | `badge.verdict` from config |

```bash
anatoly run --badge-verdict
```

---

## Logging

### --log-level \<level\>

Set the log level for structured logging output. When `--verbose` is also set, the effective level is `debug` unless `--log-level` explicitly overrides it.

| Property | Value |
|----------|-------|
| Type | enum |
| Values | `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| Default | `warn` |

```bash
anatoly run --log-level debug
anatoly run --log-level trace
```

### --log-file \<path\>

Write structured logs to a file in ndjson (newline-delimited JSON) format. Useful for post-mortem analysis and CI log aggregation.

| Property | Value |
|----------|-------|
| Type | string (file path) |
| Default | none (no file logging) |

```bash
anatoly run --log-file anatoly-debug.ndjson
```

Note: Each `run` also writes a per-run log file at `.anatoly/runs/<run-id>/anatoly.ndjson` regardless of this flag.
