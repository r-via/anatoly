# Schemas

## Zod v4 as Source of Truth

Anatoly uses [Zod v4](https://zod.dev/) (`^4.3.6`) as the single source of truth for all data structures. Every schema lives in `src/schemas/` and every TypeScript type is derived from its schema via `z.infer<>`:

```ts
export const TaskSchema = z.object({ ... });
export type Task = z.infer<typeof TaskSchema>;
```

This guarantees that runtime validation and compile-time types are always in sync. Schemas are used to:

- Validate LLM responses before persisting them
- Validate `.anatoly.yml` configuration at startup
- Validate progress state loaded from disk
- Enforce contracts between the scanner, evaluators, and merger

## Task Schema

**File:** `src/schemas/task.ts`

The Task schema represents a single file that has been scanned and is ready for review. It is the output of the scanner and the input to the evaluation pipeline.

```ts
TaskSchema = z.object({
  version:    z.literal(1),
  file:       z.string(),           // relative file path
  hash:       z.string(),           // content hash for cache invalidation
  symbols:    z.array(SymbolInfoSchema),
  coverage:   CoverageDataSchema.optional(),
  scanned_at: z.string(),           // ISO timestamp
});
```

### SymbolInfo

Each symbol discovered by the AST scanner:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Symbol identifier |
| `kind` | enum | `function`, `class`, `method`, `type`, `constant`, `variable`, `enum`, `hook` |
| `exported` | `boolean` | Whether the symbol is exported |
| `line_start` | `int >= 1` | Start line |
| `line_end` | `int >= 1` | End line |

### CoverageData

Optional per-file coverage statistics (statements, branches, functions, lines -- each with `_total` and `_covered` counts).

## Review Schema

**File:** `src/schemas/review.ts`

The Review schema is the richest schema in the project. It captures the full result of evaluating a file across all seven axes.

### ReviewFile (top level)

```ts
ReviewFileSchema = z.object({
  version:         z.union([z.literal(1), z.literal(2)]),
  file:            z.string(),
  is_generated:    z.boolean().default(false),
  skip_reason:     z.string().optional(),
  verdict:         VerdictSchema,        // 'CLEAN' | 'NEEDS_REFACTOR' | 'CRITICAL'
  symbols:         z.array(SymbolReviewSchema),
  actions:         z.array(ActionSchema).default([]),
  file_level:      FileLevelSchema,
  best_practices:  BestPracticesSchema.optional(),   // v2 only
  axis_meta:       z.record(AxisIdSchema, AxisMetaEntrySchema.optional()).optional(),
});
```

### The Seven Axes

Each symbol is evaluated on six per-symbol axes, plus one file-level axis:

| Axis | Field | Values | Meaning |
|------|-------|--------|---------|
| **Correction** | `correction` | `OK`, `NEEDS_FIX`, `ERROR` | Functional correctness |
| **Overengineering** | `overengineering` | `LEAN`, `OVER`, `ACCEPTABLE` | Complexity vs. necessity |
| **Utility** | `utility` | `USED`, `DEAD`, `LOW_VALUE` | Whether the symbol is actually used |
| **Duplication** | `duplication` | `UNIQUE`, `DUPLICATE` | Near-duplicate detection |
| **Tests** | `tests` | `GOOD`, `WEAK`, `NONE` | Test coverage quality |
| **Documentation** | `documentation` | `DOCUMENTED`, `PARTIAL`, `UNDOCUMENTED` | JSDoc coverage on exports |
| **Best Practices** | (file-level) | Score 0-10 + rules | Adherence to 17 best-practice rules |

### SymbolReview

Per-symbol review data. Includes all six per-symbol axis values plus:

- `confidence` (0-100): the evaluator's confidence in the assessment
- `detail` (min 10 chars): human-readable explanation
- `duplicate_target`: when `duplication` is `DUPLICATE`, points to the similar symbol

### Actions

Suggested remediation steps, each with:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `int >= 1` | Sequential action ID |
| `description` | `string` | What to do |
| `severity` | `high` / `medium` / `low` | Impact level |
| `effort` | `trivial` / `small` / `large` | Estimated work |
| `category` | `quickwin` / `refactor` / `hygiene` | Classification |
| `source` | `AxisId` (optional) | Which axis produced this action |
| `target_symbol` | `string` or `null` | Affected symbol |
| `target_lines` | `string` or `null` | Affected line range |

### Best Practices (v2)

File-level evaluation against 17 rules (IDs 1-17). Each rule has a status (`PASS`, `WARN`, `FAIL`) and a severity (`CRITICAL`, `HIGH`, `MEDIUM`). The overall score is 0-10.

### Axis Meta

Per-axis metadata tracking the model used, cost in USD, and duration in milliseconds. Stored as a partial record keyed by `AxisId`.

## Config Schema

**File:** `src/schemas/config.ts`

Validates the `.anatoly.yml` configuration file. The top-level `ConfigSchema` is composed of nested sub-schemas, each with sensible defaults:

```ts
ConfigSchema = z.object({
  project:  ProjectConfigSchema,   // name, monorepo flag
  scan:     ScanConfigSchema,      // include/exclude globs
  coverage: CoverageConfigSchema,  // coverage command and report path
  llm:      LlmConfigSchema,      // model, concurrency, axes config
  rag:      RagConfigSchema,       // RAG enabled flag
  logging:  LoggingConfigSchema,   // level, file, pretty
  output:   OutputConfigSchema,    // max_runs
  badge:    BadgeConfigSchema,     // badge injection settings
});
```

### Key Sub-Schemas

**LlmConfigSchema** -- the most detailed section:

| Field | Default | Description |
|-------|---------|-------------|
| `model` | `claude-sonnet-4-6` | Primary evaluation model |
| `index_model` | `claude-haiku-4-5-20251001` | Fast model for indexing |
| `concurrency` | `4` | Parallel file evaluations |
| `timeout_per_file` | `600` | Seconds before timeout |
| `max_retries` | `3` | LLM call retries |
| `min_confidence` | `70` | Minimum confidence threshold |
| `deliberation` | `false` | Enable deliberation pass |
| `deliberation_model` | `claude-opus-4-6` | Model for deliberation |
| `axes` | all enabled | Per-axis enable/disable and model overrides |

**ScanConfigSchema** -- default includes `src/**/*.ts` and `src/**/*.tsx`, excludes `node_modules`, `dist`, and test files.

**CoverageConfigSchema** -- defaults to running `npx vitest run --coverage.reporter=json` and reading `coverage/coverage-final.json`.

All defaults mean that `ConfigSchema.parse({})` produces a fully valid configuration -- zero config is a first-class use case.

## Progress Schema

**File:** `src/schemas/progress.ts`

Tracks the state of an in-progress audit run. Persisted to disk so runs can resume after interruption.

```ts
ProgressSchema = z.object({
  version:    z.literal(1),
  started_at: z.string(),                            // ISO timestamp
  files:      z.record(z.string(), FileProgressSchema),
});
```

### FileProgress

| Field | Type | Description |
|-------|------|-------------|
| `file` | `string` | Relative file path |
| `hash` | `string` | Content hash at scan time |
| `status` | enum | `PENDING`, `IN_PROGRESS`, `DONE`, `TIMEOUT`, `ERROR`, `CACHED` |
| `updated_at` | `string` | ISO timestamp of last status change |
| `error` | `string` (optional) | Error message if status is `ERROR` or `TIMEOUT` |

The `CACHED` status indicates the file's hash matched a previous run and its review was reused without re-evaluation.

## How Schemas Enforce Data Contracts

1. **LLM output validation.** Every LLM response is parsed through the relevant Zod schema before being written to disk. Malformed responses trigger retries (up to `max_retries`).

2. **Config validation at startup.** `ConfigSchema.parse()` runs against the loaded YAML. Invalid configuration fails fast with clear Zod error messages.

3. **Progress state integrity.** The progress file is validated on load. Corrupt state is detected immediately rather than causing subtle downstream failures.

4. **Type safety.** Since all types are derived via `z.infer<>`, there is no drift between runtime validation and compile-time types. A schema change automatically propagates to every consumer.

5. **Version migration.** The `version` field (literal `1` or `2`) in Task and Review schemas enables forward-compatible evolution. The review schema accepts both v1 and v2, allowing old review files to coexist with new ones.
