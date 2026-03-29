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

**Status**: Planned — high priority
**Impact**: Prevents false-positive fixes, enables cross-file coherence, reduces cost

### Current model (per-file, single-turn JSON)
- 115 calls × ~$0.21 = $24/run
- Receives ReviewFile JSON + full source code + test file
- Cannot verify anything — reasons only on what it's given
- No cross-file visibility (same false positive reclassified 15 times independently)

### Proposed model (per-shard, full-agentic)
Replace the current per-file deliberation with a single post-run agentic pass:

1. Group findings into shards (by module/directory, 10-20 files per shard)
2. Give the agent **only the shard of findings** — no code source, no prompt
3. The agent has full tool access (Read, Grep, Glob, Bash) and must **investigate each finding itself**
4. It reads files, greps usages, checks configs, verifies claims independently
5. It produces a deliberation report per shard

**Key principle**: Instead of "here's the code, tell me if the finding is correct", say "here are claims about this codebase, prove or disprove each one". The agent cannot rubber-stamp — it must do the work.

**What this solves**:
- Gold set/fixture files: agent reads the file, sees it's intentional
- Runtime values (CODE_DIM): agent checks embeddings-ready.json, verifies actual dimensions
- Dead code claims: agent greps for actual usages
- Cross-file patterns: agent sees all findings in a module together
- Default value "fixes": agent checks who uses the value, measures blast radius

**Trade-offs**:
- Estimated cost: 10-15 shards × $1-3 = $10-45 (vs $24 currently)
- Sequential per shard, but shards can run in parallel
- Needs bounded turns (maxTurns: 50-100) to prevent runaway
- Bash should be read-only (no writes — investigation only)

**Incident**: FIX-017 changed CODE_DIM fallback from 3584 to 768 based on a correction finding. An investigative agent would have read `embeddings-ready.json` and found `dim_code: 3584`, disproving the finding.

## Reduce correction axis output verbosity

**Status**: To investigate
**Impact**: ~30% output token reduction ($27/run axis)

correction produces ~10K output tokens per file with detailed fix suggestions. Could instruct the model to be more concise (max 100 chars per detail, skip code suggestions) without losing actionable information.

## Tier 2 — skip OVER/UNDOCUMENTED on LOW_VALUE

**Status**: Minor optimization
**Impact**: Marginal — reduces noise, no cost change

Currently LOW_VALUE symbols keep all their findings (OVER, UNDOCUMENTED, etc.). These are debatable — why document or refactor a symbol flagged as low value? Safe to skip OVER and UNDOCUMENTED on LOW_VALUE, similar to DEAD treatment.

## Tier 1 — add type-only importers resolution

**Status**: Minor gap
**Impact**: Catches additional DEAD → USED cases

`applyTier1` checks `getSymbolUsage` (runtime) and `getTransitiveUsage` but not `getTypeOnlySymbolUsage`. Exported types with type-only importers should be auto-resolved to USED.

## Tier 3 — switch to agentic mode

**Status**: Planned — high priority
**Impact**: Transforms tier 3 from rubber-stamp to real investigation

Current tier 3 is a single-turn JSON call via `runSingleTurnQuery` — same model as the old per-file deliberation. Opus reasons in a vacuum without verifying claims.

**Required change**: Replace `queryFn` implementation in `run.ts` with a full `query()` call:
- `allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch']`
- No maxTurns (let the agent work freely)
- No budget cap for V1 (analyze transcript patterns first)
- `permissionMode: 'bypassPermissions'`
- Parse the final JSON from `result.text`

The `Tier3Context.queryFn` interface stays the same — only the implementation changes. ~1-2h effort.

**Benchmarking opportunity**: The current run produces a baseline of tier 3 single-turn deliberation results. After switching to agentic mode, we can compare:
- Same escalated findings, same shards
- Single-turn reclassifications vs agentic reclassifications
- Cost and duration comparison
- Quality: did the agentic agent catch things the single-turn missed? (e.g. FIX-017 CODE_DIM)

This gives us a direct A/B comparison: global single-turn deliberation vs global agentic deliberation, both operating on the same tier 1+2 pre-filtered findings.
