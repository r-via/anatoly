# Diagnostic Logging

Anatoly uses structured logging via [pino](https://getpino.io/) with two independent output channels: a console transport (stderr) and an optional file transport (ndjson). By default, only `warn` and above appear on screen to keep CLI output clean.

## Table of Contents

- [Log Levels](#log-levels)
- [Usage](#usage)
- [Level Priority](#level-priority)
- [Architecture](#architecture)
- [Log Context (AsyncLocalStorage)](#log-context-asynclocalstorage)
- [Console Transport](#console-transport)
- [Per-Run File Logger](#per-run-file-logger)
- [Diagnostic Recipes](#diagnostic-recipes)

---

## Log Levels

| Level | What it shows |
|-------|--------------|
| `fatal` | Unrecoverable errors |
| `error` | File review failures, API errors |
| `warn` | Rate limit exhaustion, AST parse errors, error summaries |
| `info` | Pipeline phase start/end with durations, run summary |
| `debug` | Per-file triage/review results, usage graph stats, RAG index stats |
| `trace` | Per-LLM-call token counts, cache hit rates, cost |

---

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

# Verbose flag (shorthand for --log-level debug)
npx anatoly run --verbose
```

---

## Level Priority

The effective log level is resolved by `resolveLogLevel()` in this order:

```
--log-level flag  >  --verbose (→ debug)  >  ANATOLY_LOG_LEVEL env  >  default (warn)
```

Invalid values for `--log-level` or `ANATOLY_LOG_LEVEL` are silently ignored and fall back to `warn`.

---

## Architecture

**Source:** `src/utils/logger.ts`

### Singleton Pattern

```
initLogger()          → creates the global singleton (called once at CLI startup)
getLogger()           → returns the singleton (lazy-creates if needed)
createLogger()        → low-level factory (for custom instances)
createFileLogger()    → standalone file-only logger (for per-run ndjson)
```

| Function | Purpose |
|----------|---------|
| `initLogger(options)` | Initialize the global singleton. Warns if called more than once |
| `getLogger()` | Return the singleton. Lazy-creates a default `warn`-level logger if `initLogger()` wasn't called |
| `createLogger(options)` | Factory that creates a pino instance with console + optional file transports |
| `createFileLogger(path)` | Create a standalone debug-level file logger for per-run ndjson |
| `flushFileLogger()` | Flush buffered file output synchronously (called on SIGINT / exit) |

### Transport Targets

`createLogger()` configures up to two pino transports:

| Target | Destination | Level | Format | Condition |
|--------|-------------|-------|--------|-----------|
| Console | stderr (fd 2) | Configured level | `pino-pretty` if TTY, ndjson otherwise | Always |
| File | `--log-file` path | `debug` (always) | ndjson | Only if `--log-file` set |

The file transport always captures `debug` and above regardless of the console level. This means `--log-level warn --log-file out.log` shows warnings on screen but writes full debug output to the file.

### LoggerOptions

```typescript
interface LoggerOptions {
  level?: LogLevel;      // Console level (default: 'warn')
  logFile?: string;      // Optional file path for ndjson output
  pretty?: boolean;      // Force pretty output (default: auto-detect TTY)
  namespace?: string;    // Component name (added as 'component' field to all entries)
}
```

---

## Log Context (AsyncLocalStorage)

**Source:** `src/utils/log-context.ts`

Pipeline code uses `AsyncLocalStorage` to automatically attach context fields (run ID, file, axis) to every log entry without passing them through function arguments.

### Context Fields

```typescript
interface LogContext {
  runId?: string;   // Current run ID
  file?: string;    // File being processed
  axis?: string;    // Evaluation axis (utility, duplication, etc.)
  phase?: string;   // Pipeline phase (setup, rag-index, review, report)
  worker?: number;  // Worker pool index
}
```

### API

| Function | Description |
|----------|-------------|
| `runWithContext(ctx, fn)` | Execute `fn` within a log context. Merges with parent context (nestable) |
| `getLogContext()` | Return the current context, or `undefined` if outside any scope |
| `contextLogger(namespace?)` | Return a child logger with current context fields bound |

### Example

```typescript
runWithContext({ runId: 'abc' }, () => {
  runWithContext({ file: 'src/foo.ts' }, () => {
    const log = contextLogger();
    log.info('processing');
    // Output includes: { runId: "abc", file: "src/foo.ts", msg: "processing" }
  });
});
```

`contextLogger()` is the recommended way to log inside pipeline code. It calls `getLogger()` and creates a pino child logger with all active context fields bound.

---

## Console Transport

The console transport writes to **stderr** (fd 2), not stdout. This keeps log output separate from command output (e.g., `rag-status --json` writes data to stdout while logs go to stderr).

**Format:**
- **TTY** (interactive terminal): Uses `pino-pretty` for human-readable colored output
- **Non-TTY** (piped/CI): Uses raw ndjson (one JSON object per line)

The `pretty` option overrides TTY auto-detection.

---

## Per-Run File Logger

Every `run` command automatically creates a debug-level ndjson log at:

```
.anatoly/runs/<runId>/anatoly.ndjson
```

This is created by `createFileLogger()` — a standalone pino instance separate from the singleton. It uses `pino.destination()` with `sync: false` for buffered writes.

**Buffered output:** The file logger uses async I/O for performance. `flushFileLogger()` is called on process exit / SIGINT to ensure all buffered entries are written.

**Always debug level:** The per-run file captures all debug+ events regardless of the console log level. This enables post-mortem analysis without needing to set `--log-level debug` upfront.

---

## Diagnostic Recipes

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

# Show RAG index stats
cat $LOG | jq 'select(.msg=="RAG index summary")'

# List all context-enriched entries for a specific file
cat $LOG | jq 'select(.file=="src/cli.ts")'
```

---

See also: [Configuration](configuration.md) · [Runtime Directory](runtime-directory.md) · [How It Works](how-it-works.md)
