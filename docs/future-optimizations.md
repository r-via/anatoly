# Future Optimizations

## Multi-turn grouped axes per provider

**Status**: Planned
**Impact**: ~2.4M tokens/run saved on Gemini (~$0.18), reduced latency

Currently each axis sends the full source file independently. For a 3K-token file evaluated on 7 axes, the code is sent 7 times (21K tokens wasted).

**Proposal**: Group axes by provider into a single multi-turn conversation:
- 1 Gemini conversation: send file once, then ask utility + duplication + overengineering sequentially
- Claude axes stay isolated (each has unique context: test file, docs pages, deps)

**Trade-offs**:
- Loses per-axis concurrency within the same provider (sequential vs parallel)
- Error in one axis could affect the others in the same conversation
- Requires multi-turn query support in GeminiGenaiTransport
- Need to handle different Zod schemas per turn in the response parser

**Estimated savings**: ~20K tokens/file × 120 files = ~2.4M input tokens on Gemini

## Gemini context caching

**Status**: Investigated, not viable currently
**Reason**: System prompts are ~900-1000 tokens, under the 2048 minimum required by the Gemini caching API

Could become viable if:
- System prompts grow beyond 2048 tokens
- Google lowers the minimum threshold
- We bundle system prompt + a reusable context primer to exceed the threshold

## Route best-practices to Gemini

**Status**: To validate
**Impact**: ~$32/run saved (most expensive Claude axis)

best-practices is the costliest axis ($32.70/run, 122 calls, ~14K output tokens/call). Its output is highly structured (17 fixed rules). Could be a good candidate for Gemini if quality holds.

**Next step**: Spike with gemini-2.5-flash on 5-10 files, compare verdicts against Claude reference.

## Agentic deliberation — shard-based investigation

**Status**: DONE (Epic 41, commit a0f7045)
**Impact**: Prevents false-positive fixes, enables cross-file coherence, reduces cost

Implemented as 3-tier refinement pipeline:
- Tier 1: Deterministic auto-resolve (usage graph, AST, RAG) — 0 tokens
- Tier 2: Inter-axis coherence rules (DEAD+NEEDS_FIX moot, etc.) — 0 tokens
- Tier 3: Full agentic Opus investigation with tools (Read, Grep, Glob, Bash, WebFetch)

Prompt centralized in `src/prompts/refinement/tier3-investigation.system.md`.

## Reduce correction axis output verbosity

**Status**: To investigate
**Impact**: ~30% output token reduction ($27/run axis)

correction produces ~10K output tokens per file with detailed fix suggestions. Could instruct the model to be more concise (max 100 chars per detail, skip code suggestions) without losing actionable information.

## Tier 2 — skip OVER/UNDOCUMENTED on LOW_VALUE

**Status**: DONE
**Impact**: Marginal — reduces noise, no cost change

Currently LOW_VALUE symbols keep all their findings (OVER, UNDOCUMENTED, etc.). These are debatable — why document or refactor a symbol flagged as low value? Safe to skip OVER and UNDOCUMENTED on LOW_VALUE, similar to DEAD treatment.

## Tier 1 — add type-only importers resolution

**Status**: DONE
**Impact**: Catches additional DEAD → USED cases

`applyTier1` checks `getSymbolUsage` (runtime) and `getTransitiveUsage` but not `getTypeOnlySymbolUsage`. Exported types with type-only importers should be auto-resolved to USED.

## Tier 3 — switch to agentic mode

**Status**: DONE (commit a0f7045)

Replaced `runSingleTurnQuery` in `run.ts` queryFn with full `query()` SDK call:
- `allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch']`
- No maxTurns, no budget cap (V1 — analyze transcripts first)
- JSON extracted from agentic response via `extractJson` + Zod validation

**Benchmarking**: Three baselines available for comparison:
1. Legacy per-file Opus (`.anatoly/baseline/legacy-deliberation-run/`)
2. 3-tier single-turn (run 093442)
3. 3-tier agentic (next run)
