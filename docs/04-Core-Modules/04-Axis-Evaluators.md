# Axis Evaluators

The axis evaluator system is the core review engine of Anatoly. Each file that passes triage is evaluated through 7 independent axis evaluators running in parallel. Each axis focuses on a single quality dimension, receives its own LLM call with a specialised prompt, and returns structured JSON results validated against a Zod schema.

## Architecture Overview

```
file-evaluator.ts          Orchestrates all axes for one file
  |
  +-- axis-evaluator.ts    Shared SDK query harness, types, model resolution
  |
  +-- axes/
  |   +-- utility.ts        Haiku  - USED / DEAD / LOW_VALUE
  |   +-- duplication.ts    Haiku  - UNIQUE / DUPLICATE
  |   +-- correction.ts     Sonnet - OK / NEEDS_FIX / ERROR
  |   +-- overengineering.ts Haiku - LEAN / OVER / ACCEPTABLE
  |   +-- tests.ts          Haiku  - GOOD / WEAK / NONE
  |   +-- best-practices.ts Sonnet - Score 0-10 (17 rules)
  |   +-- documentation.ts  Haiku  - DOCUMENTED / PARTIAL / UNDOCUMENTED
  |
  +-- axis-merger.ts        Combines 7 axis results into one ReviewFile
```

## The 7 Axes

| Axis | Default Model | Output Values | Scope |
|------|--------------|---------------|-------|
| Utility | haiku | USED, DEAD, LOW_VALUE | Per symbol |
| Duplication | haiku | UNIQUE, DUPLICATE | Per symbol |
| Correction | sonnet | OK, NEEDS_FIX, ERROR | Per symbol + actions |
| Overengineering | haiku | LEAN, OVER, ACCEPTABLE | Per symbol |
| Tests | haiku | GOOD, WEAK, NONE | Per symbol |
| Best Practices | sonnet | Score 0-10 with 17 rules | File-level |
| Documentation | haiku | DOCUMENTED, PARTIAL, UNDOCUMENTED | Per symbol + concept coverage |

Each axis can be individually disabled or assigned a different model through `config.llm.axes.[axisId].enabled` and `config.llm.axes.[axisId].model`.

## Editable Markdown System Prompts

Each axis loads its system prompt from a Markdown file at `src/core/axes/prompts/`:

- `utility.system.md`
- `duplication.system.md`
- `correction.system.md`
- `overengineering.system.md`
- `tests.system.md`
- `best-practices.system.md`
- `documentation.system.md`

These are imported as raw strings at build time. The prompts define the axis's evaluation criteria, output format expectations, and rating semantics. They can be edited to adjust behaviour without changing any TypeScript code.

The shared `runSingleTurnQuery()` function prepends a no-tools directive to every system prompt:

> "IMPORTANT: You are a single-turn JSON evaluator. Do NOT use any tools. All the context you need is provided below. Respond ONLY with a JSON object."

## Claude Agent SDK Harness

All axis evaluators use the same shared harness in `axis-evaluator.ts`:

### `runSingleTurnQuery()`

This function wraps the Claude Agent SDK `query()` call with:

1. **No tools**: `allowedTools: []` -- the model receives all context in the prompt and must respond with pure JSON.
2. **Permission bypass**: `permissionMode: 'bypassPermissions'` -- no interactive permission prompts.
3. **Session persistence**: `persistSession: true` -- enables the retry pass to resume the same session.
4. **Max 2 turns**: Allows for the initial response plus one retry if validation fails.
5. **Abort support**: An `AbortController` is threaded through for graceful cancellation.

### Zod Validation with Retry

After the LLM responds, the output is processed through:

1. `extractJson()` -- strips markdown fences and extracts the JSON body.
2. `JSON.parse()` -- parses the raw string.
3. `schema.safeParse()` -- validates against the axis-specific Zod schema.

If validation fails on the first attempt, the function sends a retry message containing the Zod error details and asks the model to fix its output. If the second attempt also fails, an `AnatolyError` with code `ZOD_VALIDATION_FAILED` is thrown.

### Model Resolution

`resolveAxisModel()` determines which model to use for a given axis:

1. Check `config.llm.axes.[axisId].model` (per-axis override).
2. If the evaluator's default is `haiku`, use `config.llm.fast_model` (falling back to `config.llm.index_model`).
3. If the evaluator's default is `sonnet`, use `config.llm.model`.

## Per-Axis Context

Each evaluator receives an `AxisContext` containing:

| Field | Description |
|-------|-------------|
| `task` | The `.task.json` data (file path, symbols, coverage) |
| `fileContent` | Full source code of the file |
| `config` | Project configuration |
| `projectRoot` | Absolute path to the project |
| `usageGraph` | Pre-computed import/export graph (for utility axis) |
| `preResolvedRag` | Pre-resolved RAG similarity results (for duplication axis) |
| `fileDeps` | Dependency metadata from package.json (for correction, best_practices) |
| `projectTree` | Directory tree string (for overengineering, best_practices) |
| `docsTree` | ASCII tree of docs/ directory (for documentation axis) |
| `relevantDocs` | Resolved documentation pages with content (for documentation axis) |

## Axis-Specific Behaviour

### Utility

Receives the pre-computed import/usage graph. For each exported symbol, the prompt includes whether it is imported by other files (and how many), type-only imported, or imported by zero files (likely dead).

### Duplication

Receives pre-resolved RAG similarity search results. For each function/method/hook symbol, the vector store is queried before the LLM call. Candidate source code (up to 50 lines) is read from disk and included in the prompt for code-to-code comparison.

### Correction

Uses a two-pass architecture:
1. **Pass 1**: Standard correction evaluation.
2. **Pass 2** (conditional): If pass 1 flags any NEEDS_FIX or ERROR findings and the file imports third-party dependencies, a verification pass runs. This pass includes targeted README sections from `node_modules` to check whether findings are false positives caused by misunderstanding library APIs. False positives are recorded in a correction memory file for future runs.

### Overengineering

Receives the project directory tree to detect structural over-engineering patterns such as excessive directory nesting, single-file directories, and factory/adapter directories with few files.

### Tests

Receives Istanbul coverage data (when available) including statement, branch, function, and line coverage percentages. This data supplements the LLM's analysis of test file presence and quality.

### Best Practices

Evaluates the file against 17 TypeGuard v2 rules at the file level (not per-symbol). It receives file context detection (react-component, api-handler, utility, test, config, or general) to apply context-specific rule weighting. Returns a score from 0 to 10 with per-rule PASS/WARN/FAIL status.

### Documentation

Evaluates JSDoc documentation quality on exported symbols and optionally assesses concept coverage against `/docs/` pages.

- **JSDoc per-symbol**: Each exported symbol is rated DOCUMENTED (complete JSDoc with description, params, return type), PARTIAL (incomplete JSDoc), or UNDOCUMENTED (no JSDoc found). Types, interfaces, and test files receive DOCUMENTED by default.
- **Docs concept coverage** (optional): When a `/docs/` directory exists, the docs-resolver (`src/core/docs-resolver.ts`) maps source files to relevant documentation pages. Resolution uses `documentation.module_mapping` config first, then falls back to directory name convention matching. Up to 3 pages (max 300 lines each) are included in the prompt. Per-concept coverage is rated COVERED, PARTIAL, MISSING, or OUTDATED.
- **Graceful degradation**: When no `/docs/` directory exists, only JSDoc evaluation is performed.
- **Configuration**: `documentation.docs_path` (default: `"docs"`), `documentation.module_mapping` (optional config-driven mapping override).

## Crash Resilience (Per-Axis Isolation)

The file evaluator (`file-evaluator.ts`) runs all axis evaluators concurrently using `Promise.allSettled()`. This means:

- If one axis crashes (SDK error, timeout, validation failure), the other 6 axes still complete successfully.
- Failed axes are recorded in `failedAxes[]` and logged with full error details.
- The axis merger assigns safe defaults for crashed axes (e.g. `USED` for utility, `OK` for correction).
- The merged symbol detail string includes a crash sentinel: `*(axis crashed — see transcript)*`.
- The reporter marks reviews with crash sentinels as "degraded" and recommends re-running.

This isolation ensures that a single flaky API response never causes an entire file evaluation to fail.

## Axis Merger

After all axes complete (or fail), `axis-merger.ts` combines the results into a single `ReviewFile`:

### Symbol Merging

For each symbol from the task, the merger looks up its result from each axis by name. If an axis did not produce a result for a symbol (either because it crashed or the LLM omitted it), the axis default is used:

| Axis | Default |
|------|---------|
| utility | USED |
| duplication | UNIQUE |
| correction | OK |
| overengineering | LEAN |
| tests | NONE |
| documentation | DOCUMENTED |
| best_practices | N/A |

### Inter-Axis Coherence Rules

After merging, coherence rules reconcile contradictions:

1. **DEAD code does not need tests**: If `utility = DEAD`, force `tests = NONE`.
2. **DEAD code does not need docs**: If `utility = DEAD`, force `documentation = UNDOCUMENTED`.
3. **Errors override complexity**: If `correction = ERROR`, force `overengineering = ACCEPTABLE`.

### Contradiction Detection

The merger also checks for contradictions between correction findings and best_practices results. For example, if correction flags a NEEDS_FIX for async/error handling but best_practices Rule 12 (Async/Promises/Error handling) passes, the correction confidence is capped at 55 -- below the 60-threshold for verdict computation but above the 30-threshold for display.

### Verdict Computation

The file verdict is computed from merged symbols using a confidence threshold of 60:

- **CRITICAL**: At least one symbol has `correction = ERROR` with confidence >= 60.
- **NEEDS_REFACTOR**: At least one symbol has a confirmed finding (NEEDS_FIX, DEAD, DUPLICATE, OVER, or UNDOCUMENTED exported) with confidence >= 60, or 3+ symbols with PARTIAL documentation.
- **CLEAN**: No actionable findings above the confidence threshold.

### Deliberation Pass

After axis merging, an optional deliberation pass can run (when `config.llm.deliberation` is enabled). This uses a separate model to re-examine files that have findings and potentially adjust verdicts. The deliberation only triggers for files that are not already CLEAN.

## Key Source Paths

- Axis evaluator harness: `src/core/axis-evaluator.ts`
- File evaluator (orchestrator): `src/core/file-evaluator.ts`
- Axis merger: `src/core/axis-merger.ts`
- Individual axes: `src/core/axes/utility.ts`, `duplication.ts`, `correction.ts`, `overengineering.ts`, `tests.ts`, `best-practices.ts`, `documentation.ts`
- Docs resolver: `src/core/docs-resolver.ts`
- Axis index: `src/core/axes/index.ts`
- System prompts: `src/core/axes/prompts/*.system.md`
