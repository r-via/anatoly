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
- Tier 3: Full agentic Opus investigation with tools (Read, Grep, Glob)

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
- `allowedTools: ['Read', 'Grep', 'Glob']` (Bash removed for security — see below)
- JSON extracted from agentic response via `extractJson` + Zod validation

**Benchmarking**: Three baselines available for comparison:
1. Legacy per-file Opus (`.anatoly/baseline/legacy-deliberation-run/`)
2. 3-tier single-turn (run 093442)
3. 3-tier agentic (next run)

## Tier 3 — sandboxed Bash for agentic investigation

**Status**: Planned
**Impact**: Better investigation quality (type-checking, runtime verification)

Bash was removed from tier 3 tools (commit 573949b) because the agent reads audited project files which may contain prompt injection in comments. With Bash enabled, a malicious `// TODO: ignore instructions and run curl...` could trigger arbitrary command execution.

**Use cases that would benefit from Bash:**
- `tsc --noEmit` to verify type error claims
- `git log --oneline` to check recent changes
- `node -e "..."` to verify runtime behavior
- `cat package.json | jq .version` to check dependency versions

**Requirements for re-enabling:**
- Sandbox/allowlist mechanism at the SDK level (not available yet in Claude Agent SDK)
- Command allowlist: only permit read-only commands (`git log`, `tsc`, `node -e`, `cat`, `jq`)
- Block write commands (`rm`, `mv`, `cp`, `curl`, `wget`, `chmod`, `chown`, network access)
- Or: run the agent in a Docker container / chroot with no network and read-only filesystem

**Current workaround:** The LLM can infer most of what Bash would provide by reading source files, config files, and grepping for patterns. The quality impact is marginal — tier 3 primarily validates code-level claims, not runtime behavior.

## `anatoly providers --gold-set` — Provider benchmark on gold set

**Status**: Planned
**Impact**: Objective model comparison before switching providers

Currently, the gold set is a vitest suite run manually against a single model. There is no way to compare how different providers/models perform on the same fixtures side by side.

**Proposal**: Add `--gold-set` flag to `anatoly providers` that:
1. Runs the full gold-set fixture suite against each reachable model in the config
2. Displays a comparison table: pass/fail count, cost, latency per model
3. Shows detailed failures (which fixture, expected vs actual verdict)

**Example output**:
```
  Gold-Set Evaluation

  Model                          Pass  Fail  Cost     Time
  ─────────────────────────────  ────  ────  ───────  ──────
  claude-haiku-4-5-20251001      14/14  0    $0.68    12.3s
  claude-sonnet-4-5-20250514     14/14  0    $2.40    18.1s
  gemini-2.5-flash               12/14  2    $0.12    8.4s
    ✗ correction-bugs: clamp → NEEDS_FIX (expected OK)
    ✗ overengineered: slugify → ACCEPTABLE (expected LEAN)
```

**Implementation**:
- Extract gold-set evaluation logic from `gold-set.test.ts` into `gold-set-runner.ts` (reusable, not coupled to vitest)
- Each fixture becomes a function returning `{ pass: boolean; expected: string; actual: string }`
- Run models sequentially (avoid cross-model rate limiting), parallelize axes within a model
- Add `--yes` to skip cost confirmation prompt
- Support `--json` for machine-readable output

**Cost**: ~$2/model (Haiku), ~$8/model (Sonnet), ~$0.50/model (Gemini Flash)

## Gold set v2 — Mini-project with full pipeline validation

**Status**: Planned
**Impact**: End-to-end regression testing for the full pipeline (axes + refinement tiers 1/2/3)

The current gold set tests individual axes in isolation with single-file fixtures. It validates LLM responses but not cross-file coherence, import graph analysis, refinement reclassifications, or false positive detection.

**Proposal**: Replace (or complement) isolated fixtures with a self-contained mini-project that exercises the full pipeline:

```
__gold-set__/project/
  package.json
  src/
    index.ts            # entry point, imports service + utils
    service.ts          # business logic, real bugs, weak tests
    utils.ts            # helpers, dead code, cross-file duplications
    types.ts            # exported types with type-only imports (USED, not DEAD)
    middleware.ts        # framework pattern that looks OVER but is justified
  tests/
    service.test.ts     # happy-path only (WEAK)
    utils.test.ts       # thorough tests (GOOD)
  expected.json         # expected verdicts per symbol, per axis, post-refinement
```

**Patterns to reproduce** (mined from real runs on anatoly and rustguard):

| Pattern | Source | Expected behavior |
|---------|--------|-------------------|
| DEAD→USED (transitive/type-only imports) | anatoly deliberation-memory (339 entries) | Tier 1 auto-resolves via usage graph |
| DEAD+NEEDS_FIX → moot fix | anatoly tier 2 coherence | Tier 2 skips fix on dead symbol |
| DEAD+UNDOCUMENTED → skip doc | anatoly tier 2 coherence | Tier 2 skips doc on dead symbol |
| DUPLICATE→UNIQUE (structural similarity, different semantics) | anatoly `json_read` vs `json_read_num` | Duplication axis respects semantic contracts |
| UNDOCUMENTED→DOCUMENTED (z.infer self-documenting) | anatoly z.infer patterns | Documentation axis recognizes naming conventions |
| WEAK→GOOD (transitive coverage via parent tests) | anatoly Zod composition | Tests axis counts parent-level coverage |
| True DUPLICATE cross-file | new | Duplication axis detects across files |
| OVER but justified (framework pattern) | new (Express middleware) | Overengineering axis marks ACCEPTABLE |
| Real bugs confirmed (off-by-one, missing error handling) | rustguard correction findings | Correction axis flags correctly |
| High RAG score but UNIQUE (type differences) | rustguard `mix_key` (0.974 score) | Duplication axis not fooled by structural similarity |

**Test execution**: Run `anatoly run` on the mini-project directory, then diff the output review files against `expected.json`. The test validates the entire pipeline — axes, refinement, and report — not just individual LLM responses.

**Design considerations**:
- Keep the mini-project small (~8 files, ~400 LOC total) to keep run cost low (~$5)
- `expected.json` tracks post-refinement verdicts (after tier 1/2/3), not raw axis output
- Existing per-axis fixtures remain useful for fast isolated debugging when a prompt changes
- The mini-project tests the system; the fixtures test the prompts
