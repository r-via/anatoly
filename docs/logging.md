# Diagnostic Logging

Anatoly uses structured logging (via [pino](https://getpino.io/)) for diagnostic output. By default, only `warn` and above are shown to keep CLI output clean.

## Log levels

| Level | What it shows |
|-------|--------------|
| `fatal` | Unrecoverable errors |
| `error` | File review failures, API errors |
| `warn` | Rate limit exhaustion, AST parse errors, error summaries |
| `info` | Pipeline phase start/end with durations, run summary |
| `debug` | Per-file triage/review results, usage graph stats, RAG index stats |
| `trace` | Per-LLM-call token counts, cache hit rates, cost |

## Usage

```bash
# Show info-level pipeline progress
npx anatoly run --log-level info

# Full debug output to terminal
npx anatoly run --log-level debug

# Write debug logs to a file (ndjson)
npx anatoly run --log-file anatoly.log

# Combine: info on screen, debug to file
npx anatoly run --log-level info --log-file anatoly.log

# Use environment variable
ANATOLY_LOG_LEVEL=debug npx anatoly run
```

## Per-run log file

Every `run` command automatically creates a debug-level ndjson log at `.anatoly/runs/<runId>/anatoly.ndjson`. This captures phase start/end events, per-file review results, errors, triage classifications, and the run summary — useful for post-mortem analysis without needing to set `--log-level debug` upfront.

## Diagnostic recipes

Filter the per-run ndjson log with `jq` to answer common questions:

```bash
LOG=.anatoly/runs/latest/anatoly.ndjson

# Why was a file skipped by triage?
cat $LOG | jq 'select(.file=="src/foo.ts" and .msg=="triage classification")'

# Which axes failed during the run?
cat $LOG | jq 'select(.level>=40 and .axis)'

# Show all errors grouped by code
cat $LOG | jq 'select(.msg=="run error summary")'

# How long did each phase take?
cat $LOG | jq 'select(.msg=="phase completed") | {phase, durationMs}'

# How much did this run cost?
cat $LOG | jq 'select(.msg=="run completed") | {totalCostUsd, totalDurationMs, filesReviewed}'

# Which files had the most expensive reviews?
cat $LOG | jq 'select(.msg=="file review completed") | {file, costUsd, durationMs}' | jq -s 'sort_by(-.costUsd)'
```

## Priority order

`--log-level` flag > `--verbose` (maps to `debug`) > `ANATOLY_LOG_LEVEL` env > default (`warn`)
