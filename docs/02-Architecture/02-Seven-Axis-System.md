# Seven-Axis Evaluation System

Anatoly evaluates every file through seven independent axis evaluators, each focused on a single dimension of code quality. The axes run in parallel for each file, and their results are merged into a unified `ReviewFile`.

## Axes at a Glance

| Axis | ID | Default Model | Verdicts | Purpose |
|------|----|---------------|----------|---------|
| Utility | `utility` | Haiku | `USED`, `DEAD`, `LOW_VALUE` | Detect dead or low-value code |
| Duplication | `duplication` | Haiku | `UNIQUE`, `DUPLICATE` | Find semantically duplicated functions |
| Correction | `correction` | Sonnet | `OK`, `NEEDS_FIX`, `ERROR` | Identify bugs and logic errors |
| Overengineering | `overengineering` | Haiku | `LEAN`, `OVER`, `ACCEPTABLE` | Flag excessive complexity |
| Tests | `tests` | Haiku | `GOOD`, `WEAK`, `NONE` | Assess test coverage quality |
| Best Practices | `best_practices` | Sonnet | Score 0-10, 17 rules | Evaluate adherence to TypeScript best practices |
| Documentation | `documentation` | Haiku | `DOCUMENTED`, `PARTIAL`, `UNDOCUMENTED` | Detect JSDoc gaps and /docs/ desynchronization |

## Per-Axis Details

### Utility

Determines whether each exported symbol is actually consumed by other files in the project.

- **Input:** file source, symbol list, pre-computed usage graph data (importers per symbol, type-only vs runtime)
- **Output:** per-symbol verdict (`USED` / `DEAD` / `LOW_VALUE`), confidence 0-100, detail string
- **Key feature:** the usage graph provides ground-truth import data directly in the prompt, so the LLM validates rather than guesses

### Duplication

Detects semantically similar functions across the codebase using RAG-powered similarity search.

- **Input:** file source, symbol list, pre-resolved RAG similarity results (top candidates with scores, signatures, source snippets up to 50 lines)
- **Output:** per-symbol verdict (`UNIQUE` / `DUPLICATE`), confidence 0-100, detail string, optional `duplicate_target` (file, symbol, similarity description)
- **Key feature:** candidate source code is read from disk and included in the prompt for code-to-code comparison. When RAG is unavailable, all symbols default to `UNIQUE` with 90% confidence.

### Correction

Identifies bugs, logic errors, and correctness issues. This is the only axis that uses a two-pass approach.

- **Input:** file source, symbol list, project dependency metadata (package names + versions), known false positives from correction memory
- **Output:** per-symbol verdict (`OK` / `NEEDS_FIX` / `ERROR`), confidence 0-100, detail string, plus `actions` (with severity: CRITICAL/MAJOR/MINOR)
- **Two-pass verification:** when Pass 1 flags any symbol as NEEDS_FIX or ERROR and the file imports external dependencies, a Pass 2 re-evaluates those findings against the actual README documentation of the implicated libraries. Findings contradicted by library docs are reclassified to OK. False positives are recorded in correction memory (`.anatoly/correction-memory.json`) for future runs.
- **Deliberation feedback:** when the Opus deliberation pass reclassifies a correction finding (NEEDS_FIX/ERROR → OK), the false positive is also recorded in correction memory with the deliberation reasoning, preventing recurrence in future runs.

### Overengineering

Flags symbols that exhibit excessive structural complexity relative to their purpose.

- **Input:** file source, symbol list, project tree structure (directory layout)
- **Output:** per-symbol verdict (`LEAN` / `OVER` / `ACCEPTABLE`), confidence 0-100, detail string
- **Key feature:** the project tree enables detection of structural fragmentation (single-file directories, excessive nesting, factory/adapter directories with few files)

### Tests

Assesses the quality and coverage of tests for each symbol.

- **Input:** file source, symbol list, coverage data (if available: statements, branches, functions, lines with covered/total counts)
- **Output:** per-symbol verdict (`GOOD` / `WEAK` / `NONE`), confidence 0-100, detail string

### Best Practices

A file-level (not symbol-level) evaluation against 17 TypeScript best-practice rules. Each rule is scored PASS/WARN/FAIL with a severity tier (CRITICAL/HIGH/MEDIUM).

- **Input:** file source, file context (auto-detected: react-component, api-handler, utility, test, config, general), file stats (line count, symbol count), dependency metadata, project tree
- **Output:** overall score 0-10, per-rule status array, code suggestions (with optional before/after snippets)
- **Key feature:** file context detection adjusts which rules are most relevant (e.g., React-specific patterns only flagged for `.tsx` files)

### Documentation

Detects JSDoc documentation gaps on exported symbols and evaluates concept coverage against `/docs/` pages.

- **Input:** file source, symbol list, docs directory tree (ASCII, built once per run), relevant documentation pages (resolved via config mapping or filename convention, max 3 pages x 300 lines)
- **Output:** per-symbol verdict (`DOCUMENTED` / `PARTIAL` / `UNDOCUMENTED`), confidence 0-100, detail string, optional `docs_coverage` with per-concept status (`COVERED` / `PARTIAL` / `MISSING` / `OUTDATED`)
- **Key feature:** two-level evaluation: (1) JSDoc inline per symbol — checks for description, params, return type; (2) `/docs/` concept coverage — matches source module to documentation pages via `documentation.module_mapping` config or directory name convention. Gracefully degrades when no `/docs/` directory exists (evaluates JSDoc only).

> **Note:** The documentation *axis* (Haiku) **evaluates** existing documentation quality. It is distinct from the doc-generation *pipeline* (`anatoly docs`, Sonnet), which **writes** `.anatoly/docs/` pages from source code context. The axis reads docs; the pipeline creates them.

## Scoring Model

Each symbol-level axis produces three key fields:

1. **Verdict** -- the axis-specific enum value (e.g., `USED`, `NEEDS_FIX`, `LEAN`)
2. **Confidence** -- integer 0-100 representing the evaluator's certainty
3. **Detail** -- human-readable explanation (minimum 10 characters, enforced by Zod)

Confidence drives verdict computation:
- Symbols with confidence below **60** are excluded from the global verdict calculation
- Symbols with confidence below **30** are considered too unreliable and discarded
- The merged symbol confidence is the **minimum** across all contributing axes

## Axis Merger Logic

After all axes complete, the `mergeAxisResults` function in `axis-merger.ts` combines them:

1. **Build axis map:** index each axis's results by symbol name for O(1) lookup
2. **Merge per symbol:** for each symbol in the task, look up its result from each axis. Missing results (axis did not return data for that symbol) fall back to safe defaults:
   - utility: `USED`, duplication: `UNIQUE`, correction: `OK`, overengineering: `LEAN`, tests: `NONE`, documentation: `DOCUMENTED`
3. **Apply coherence rules:**
   - If utility = `DEAD`, force tests = `NONE` (no point testing dead code)
   - If utility = `DEAD`, force documentation = `UNDOCUMENTED` (no point documenting dead code)
   - If correction = `ERROR`, force overengineering = `ACCEPTABLE` (complexity is secondary to correctness)
4. **Detect contradictions:** cross-reference correction findings against best_practices results. If best_practices Rule 12 (Async/Promises/Error handling) passes but correction flags an async-related NEEDS_FIX, the correction confidence is capped at 55 (below the 60 verdict threshold).
5. **Merge actions:** collect actions from all axes, tag each with its source axis, and re-assign sequential IDs.
6. **Compute verdict:**
   - Any symbol with correction = `ERROR` (above confidence threshold) produces `CRITICAL`
   - Any symbol with `NEEDS_FIX`, `DEAD`, `DUPLICATE`, `OVER`, or `UNDOCUMENTED` (exported) produces `NEEDS_REFACTOR`
   - 3 or more symbols with `PARTIAL` documentation produces `NEEDS_REFACTOR`
   - Otherwise: `CLEAN`
7. **Build axis metadata:** record model, cost, and duration per axis in the `axis_meta` field

## Crash Isolation

Each axis evaluator runs inside `Promise.allSettled`, meaning a failure in one axis does not prevent the others from completing. When an axis crashes:

- The failure is logged with full error details
- The failed axis ID is recorded in the `failedAxes` array
- For symbols evaluated by the crashed axis, the merger applies safe defaults
- The symbol detail includes a sentinel: `*(axis crashed -- see transcript)*`
- The file's review is marked as "degraded" in run metrics (`degradedReviews` counter)
- The transcript records the failure alongside the successful axes' transcripts

This design ensures that a transient API error or model timeout on one axis (e.g., best_practices) does not block the remaining six axes from producing useful results.

## Model Configuration

Each axis has a `defaultModel` property (`'haiku'` or `'sonnet'`). The effective model is resolved as:

1. Per-axis config override: `llm.axes.<axis>.model` (highest priority)
2. Fast model pool: if `defaultModel` is `'haiku'`, use `llm.fast_model` (falls back to `llm.index_model`)
3. Standard model: if `defaultModel` is `'sonnet'`, use `llm.model`

This allows cost optimization by routing lightweight axes (utility, duplication, overengineering, tests, documentation) to cheaper models while using more capable models for correction and best_practices.
