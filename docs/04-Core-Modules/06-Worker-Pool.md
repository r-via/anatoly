# Worker Pool

The worker pool (`src/core/worker-pool.ts`) and rate limiter (`src/utils/rate-limiter.ts`) manage concurrent file evaluation. The pool dispatches files to parallel workers up to a configurable concurrency limit, while the rate limiter handles API throttling with exponential backoff and jitter.

## Concurrency Model

### Pool Design

`runWorkerPool()` implements a concurrent worker pool with shared-counter dispatch:

1. A shared `nextIndex` counter tracks the next unprocessed item.
2. N worker coroutines are launched in parallel, where N = `min(concurrency, items.length)`.
3. Each worker loops: grab the next index, process the item, repeat until no items remain.
4. `Promise.all()` waits for all workers to finish.

This design ensures that if one file takes longer than others, the remaining workers continue processing. There is no per-batch synchronisation -- a fast worker will process many files while a slow worker handles one.

### Concurrency Range

The concurrency setting accepts values from 1 to 10 workers. Higher values increase throughput but also increase API rate limit pressure. The estimator models this with a 75% efficiency factor (`CONCURRENCY_EFFICIENCY = 0.75`), meaning 4 workers deliver roughly 3x throughput rather than 4x.

### Configuration

Concurrency is set via:
- CLI flag: `--concurrency N`
- Config file: `config.llm.concurrency`
- Default: 4 (configurable 1-10)

## Interruption Handling

The worker pool supports graceful interruption via the `isInterrupted` callback:

- Before processing each item, the worker checks `isInterrupted()`.
- If interrupted, the worker stops picking up new items.
- In-flight workers are NOT aborted -- they complete their current item before stopping.
- Items that were never started are counted as `skipped` in the result.

This design prevents data corruption from partially-written review files while allowing the user to stop a long run with Ctrl+C.

### Pool Result

```typescript
{
  completed: number;  // items where handler returned successfully
  errored: number;    // items where handler threw an error
  skipped: number;    // items never started (due to interruption)
}
```

## Error Handling Per Worker

Errors in individual file handlers are caught by the pool -- they increment the `errored` counter but do not stop other workers. The handler itself (in the run command) is expected to:

1. Catch and log errors.
2. Write error state to progress.json.
3. Continue without crashing the pool.

This means a single file that causes an SDK timeout or validation failure does not prevent the remaining files from being evaluated.

## Rate Limiting and Retry Backoff

The rate limiter (`src/utils/rate-limiter.ts`) wraps each file evaluation with automatic retry logic for HTTP 429 (rate limit) errors.

### Detection

`isRateLimitError()` checks for rate limit errors in two ways:

1. `AnatolyError` instances with code `SDK_ERROR` whose message contains "429", "rate limit", or "rate_limit".
2. Generic `Error` instances with matching message content.

### Backoff Formula

```
delay = min(baseDelay * 2^attempt, maxDelay) * (1 +/- jitter)
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `baseDelayMs` | Configured per use | Starting delay for first retry |
| `maxDelayMs` | Configured per use | Maximum delay cap |
| `jitterFactor` | 0.2 | Random variation of +/-20% to prevent thundering herd |
| `maxRetries` | Configured per use | Maximum number of retry attempts |

Example progression with `baseDelayMs = 5000`, `maxDelayMs = 120000`, `maxRetries = 5`:

| Attempt | Base Delay | With Jitter (approx.) |
|---------|-----------|----------------------|
| 0 | 5,000ms | 4,000-6,000ms |
| 1 | 10,000ms | 8,000-12,000ms |
| 2 | 20,000ms | 16,000-24,000ms |
| 3 | 40,000ms | 32,000-48,000ms |
| 4 | 80,000ms | 64,000-96,000ms |
| 5 | 120,000ms (capped) | 96,000-144,000ms |

### Interruption During Backoff

The `sleep()` function polls every 250ms during backoff waits, checking the `isInterrupted` callback. This ensures that Ctrl+C is detected quickly even during a long 60-second backoff wait, rather than blocking until the full delay expires.

### Exhaustion

If all retries are exhausted, the rate limiter throws an `AnatolyError` with the suggestion: "reduce --concurrency or try again later". This error propagates to the worker pool's error handler for the affected file.

## Progress Tracking

While the worker pool itself does not track progress, the run command handler that uses it updates `progress.json` after each file completes. This enables:

- **Resume after interruption**: On restart, files already marked DONE or CACHED are skipped.
- **Live monitoring**: The progress display can read progress.json during a run.
- **Error recovery**: Files that errored can be identified and re-run.

## Key Source Paths

- Worker pool: `src/core/worker-pool.ts`
- Rate limiter: `src/utils/rate-limiter.ts`
- Error types: `src/utils/errors.ts`
