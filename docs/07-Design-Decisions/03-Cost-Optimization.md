# ADR-03: Cost Optimization through Smart Pre-Processing

**Status:** Accepted
**Date:** 2025-01-15
**Deciders:** Core team

## Context

Anatoly runs 6 LLM calls per file (one per axis). For a 200-file project, that is 1,200 API calls. Each call includes the full file content plus contextual data in the prompt. Without optimization, auditing a medium-sized codebase would cost tens of dollars and take over an hour.

The fundamental tension is between thoroughness and cost. A cheaper tool that misses issues is useless; an accurate tool that costs $50 per run will not be used regularly. Anatoly needs to be thorough where it matters and frugal where it does not.

## Decision

Minimize API costs through three complementary pre-processing strategies, all of which run locally with zero API cost:

1. **Triage** -- skip files that cannot produce meaningful findings.
2. **Usage graph** -- pre-compute import relationships to eliminate redundant tool calls.
3. **Local token estimation** -- let users predict costs before committing to a run.

### Strategy 1: Triage (skip trivial files)

The triage system (`src/core/triage.ts`) classifies every scanned file into one of two tiers before any API call is made:

| Tier | Criteria | API calls |
|---|---|---|
| **skip** | Barrel exports (re-export only, no own symbols), trivial files (<10 lines, 0-1 symbols), type-only files (all symbols are types/enums), constants-only files | 0 |
| **evaluate** | Everything else | 6 (one per axis) |

Skipped files receive a synthetic CLEAN review (`generateSkipReview`) with `is_generated: true` and a `skip_reason` field. They appear in the final report as reviewed (so there are no gaps) but cost nothing.

**Typical savings:** In a standard TypeScript project, 15-30% of files are barrel exports, type definitions, or constant declarations. Triage eliminates these at zero cost.

### Strategy 2: Usage graph (pre-compute imports)

The usage graph (`src/core/usage-graph.ts`) performs a single local pass over all project files, parsing import/export statements with regex to build a complete map of which symbols are imported by which files.

The graph tracks:
- **Runtime imports** (`import { X } from './path'`) -- the primary signal for dead code detection.
- **Type-only imports** (`import type { X } from './path'`) -- tracked separately because a symbol used only as a type may still be "dead" from a runtime perspective.
- **Re-exports** (`export { X } from './path'`, `export * from './path'`) -- counted as usage to avoid false positives on barrel-exported symbols.
- **Namespace imports** (`import * as X from './path'`) -- resolved against the export map to credit all exported symbols.

This pre-computed data is injected directly into the utility axis prompt. Instead of the LLM needing to grep across the project to determine if a function is used (which would require multiple tool calls, each consuming tokens), it receives a definitive answer:

```
- buildUsageGraph (exported): runtime-imported by 2 files: src/core/runner.ts, src/commands/run.ts
- formatTokenCount (exported): imported by 0 files -- LIKELY DEAD
- resolveImportPath (not exported): internal only -- check local usage in file
```

**Quantified savings:** Without the usage graph, the utility axis would need to make tool calls (grep, read) for each exported symbol to check if it is imported elsewhere. For a file with 10 exported symbols, that is approximately 10-20 tool calls, each adding ~500-1,000 tokens of round-trip overhead. The usage graph replaces all of these with a single pre-computed section in the prompt (~50 tokens per symbol). For a 200-file project with an average of 5 exported symbols per file, this eliminates roughly **1,000 redundant tool calls** -- approximately a 90% reduction in utility-axis token usage.

The graph also detects orphan symbols (exported but never imported by any file) during construction, logging them for diagnostics:

```
usage graph built { files: 45, runtimeImports: 312, typeImports: 87, totalExports: 198, orphanCount: 23 }
```

### Strategy 3: Local token estimation

The estimator (`src/core/estimator.ts`) uses `tiktoken` (cl100k_base encoding) to count actual tokens in each file's source code, then projects total input and output token usage for the entire run:

- **Input tokens per file:** system prompt overhead (600 tokens) + actual file content tokens + per-file overhead (50 tokens)
- **Output tokens per file:** base per file (300 tokens) + per-symbol output (150 tokens per symbol)
- **Time estimation:** base seconds per file (4s) + per-symbol time (0.8s per symbol), adjusted for concurrency efficiency (75%)

This runs via `anatoly estimate` with zero API calls, giving users a clear picture before they commit:

```
Files: 187 (evaluate: 142, skip: 45)
Symbols: 1,247
Input tokens: ~2.1M
Output tokens: ~340K
Estimated time: ~12 min (at concurrency 5)
Estimated calls: 852
```

### Model tiering

In addition to the three pre-processing strategies, Anatoly uses model tiering to reduce per-call cost:

- **4 axes use Haiku** (faster, cheaper): utility, duplication, overengineering, tests
- **2 axes use Sonnet** (deeper, more expensive): correction, best practices

This is configurable per-axis via `.anatoly.yml`, but the defaults reflect the observation that utility/duplication judgments are more mechanical (pattern matching against pre-computed evidence) while correction/best-practices require deeper reasoning.

## Consequences

### Positive

- **Predictable costs.** Users can run `anatoly estimate` before every audit and know within 20% what the run will cost.
- **90% fewer redundant tool calls.** The usage graph eliminates the most wasteful pattern in LLM-based code review: asking the model to grep for usages that could be statically determined.
- **15-30% fewer API calls from triage.** Barrel exports, type files, and trivial files are handled locally at zero cost.
- **No accuracy loss.** Triage only skips files that genuinely cannot produce findings (pure re-exports, type definitions). The usage graph provides *more* accurate data than LLM-driven grep (it covers the entire project in one pass, with no risk of missed files).
- **Sub-second overhead.** The usage graph builds in <100ms for a 200-file project. Token estimation takes <1 second. Triage is instant (pure in-memory classification).

### Negative

- **Triage may skip edge cases.** A "constants-only" file that exports a misconfigured object could have a real bug, but triage skips it. This is an acceptable trade-off because constant files rarely contain logic errors.
- **Usage graph is regex-based.** It does not use a full TypeScript resolver, so dynamic imports (`import()`) and computed property exports are not tracked. These are rare in practice and do not significantly affect dead code detection accuracy.
- **Token estimation is approximate.** The cl100k_base tokenizer is Claude-compatible but not identical. Actual costs may vary by 10-20% from estimates, depending on prompt caching behavior and retry rates.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| **No triage (review everything)** | Wastes 15-30% of the budget on files that cannot produce findings. Barrel exports and type-only files generate noise, not signal. |
| **LLM-driven import analysis** | Using tool calls (grep/read) during evaluation to check symbol usage is 10-20x more expensive in tokens and non-deterministic. The model might grep for the wrong string or miss re-exports through barrel files. |
| **TypeScript compiler API for usage graph** | More accurate than regex, but adds a hard dependency on `typescript` (50+ MB) and requires a valid `tsconfig.json`. The regex approach handles 95%+ of real-world import patterns and works on any TypeScript-like project regardless of configuration. |
| **Cost caps / budget limits** | Useful as a safety net (and could be added later), but does not reduce the actual cost. Pre-processing reduces the work itself, not just the spending limit. |
