# Estimator

The estimator (`src/core/estimator.ts`) provides pre-run cost and time projections. It counts tokens locally using tiktoken, models the expected LLM call volume, and computes wall-clock time estimates factoring in concurrency efficiency. The `anatoly estimate` command uses this module to let users preview costs before committing to a full run.

## Token Counting

Token counting uses the `tiktoken` library with the `cl100k_base` encoding, which is compatible with Claude models.

```typescript
const enc = get_encoding('cl100k_base');
const tokens = enc.encode(text).length;
enc.free();
```

The encoder is allocated and freed per call in `countTokens()`. For bulk estimation in `estimateTasksTokens()`, a single encoder instance is reused across all files to avoid repeated allocation overhead.

## Per-file Token Model

For each `.task.json` file, the estimator reads the actual source file from disk and counts its tokens. The input token estimate for a single file is:

```
inputTokens = SYSTEM_PROMPT_TOKENS + fileTokens + PER_FILE_OVERHEAD_TOKENS
```

| Constant | Value | Purpose |
|----------|-------|---------|
| `SYSTEM_PROMPT_TOKENS` | 600 | Estimated tokens for the axis system prompt |
| `PER_FILE_OVERHEAD_TOKENS` | 50 | JSON framing, symbol list, section headers |

If the source file has been deleted since the scan, the estimator falls back to a heuristic: `(line_end - line_start + 1) * 8` tokens per symbol.

Output tokens are estimated as:

```
outputTokens = OUTPUT_BASE_PER_FILE + symbolCount * OUTPUT_TOKENS_PER_SYMBOL
```

| Constant | Value | Purpose |
|----------|-------|---------|
| `OUTPUT_BASE_PER_FILE` | 300 | Base output tokens regardless of symbol count |
| `OUTPUT_TOKENS_PER_SYMBOL` | 150 | Additional output tokens per symbol reviewed |

## Time Estimation

Time estimation uses a linear model based on symbol count:

```
fileSeconds = BASE_SECONDS + symbolCount * SECONDS_PER_SYMBOL
```

| Constant | Value | Notes |
|----------|-------|-------|
| `BASE_SECONDS` | 4 | Fixed overhead per file (file read, prompt assembly, RAG) |
| `SECONDS_PER_SYMBOL` | 0.8 | LLM output scales with symbol count |

Example estimates:
- 5 symbols: ~8 seconds
- 20 symbols: ~20 seconds

### Concurrency Adjustment

The sequential time total is adjusted for parallel execution:

```
effectiveSeconds = sequentialSeconds / (concurrency * CONCURRENCY_EFFICIENCY)
```

`CONCURRENCY_EFFICIENCY` is 0.75 (25% overhead), accounting for:
- API rate limits and contention
- Tail effects (last workers finish alone while others idle)
- Network latency variance

The result is rounded up to the nearest minute.

## LLM Call Count

Each file is evaluated by 6 independent axis evaluators, so:

```
estimatedCalls = files * AXIS_COUNT
```

The 7 axes are split between two model tiers:

| Tier | Axes | Count |
|------|------|-------|
| Haiku (fast/cheap) | utility, duplication, overengineering, tests, documentation | 5 |
| Sonnet (deep/costly) | correction, best_practices | 2 |

## Full Project Estimate

`estimateProject()` loads all `.task.json` files from `.anatoly/tasks/` and returns a complete `EstimateResult`:

```typescript
{
  files: number;           // total files to review
  symbols: number;         // total symbols across all files
  inputTokens: number;     // estimated input tokens (all axes combined)
  outputTokens: number;    // estimated output tokens
  estimatedMinutes: number; // sequential wall-clock estimate
  estimatedCalls: number;  // total LLM API calls (files * 6)
}
```

## Display Formatting

`formatTokenCount()` converts raw token numbers into human-readable strings:

| Input | Output |
|-------|--------|
| 1,200,000 | `~1.2M` |
| 340,000 | `~340K` |
| 500 | `~500` |

## Key Source Paths

- Estimator: `src/core/estimator.ts`
- Task loading: `src/core/estimator.ts` (`loadTasks()`)
- Task schema: `src/schemas/task.ts`
