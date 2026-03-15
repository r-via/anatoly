# Triage

The triage module (`src/core/triage.ts`) classifies each scanned file into one of two tiers -- **skip** or **evaluate** -- before it reaches the LLM axis evaluators. Files assigned to the skip tier receive a synthetic CLEAN review with zero API calls, reducing both cost and runtime.

## Classification Tiers

| Tier | Effect |
|------|--------|
| `skip` | File is auto-reviewed as CLEAN. No LLM calls are made. |
| `evaluate` | File enters the full 6-axis evaluation pipeline. |

There is no "fast" vs "deep" distinction within the evaluate tier. All non-skip files go through the same axis evaluator pipeline.

## Skip Rules

A file is classified as **skip** when any of the following conditions are met, checked in order:

### 1. Barrel Export

The file has zero symbols extracted by the scanner AND every non-empty line matches `^\s*export\s`. This catches index files that only re-export from other modules:

```typescript
export { Scanner } from './scanner.js';
export { Estimator } from './estimator.js';
export * from './types.js';
```

### 2. Trivial File

The file has fewer than 10 lines AND contains 0 or 1 symbol. These are typically stub files, single-constant modules, or minimal type re-exports.

### 3. Type-Only File

Every symbol in the file has kind `type` or `enum`. Files that contain only type definitions and enums have no runtime behavior to review for correctness, utility, or overengineering.

### 4. Constants-Only File

Every symbol in the file has kind `constant`. Pure configuration objects and constant tables are unlikely to contain actionable findings.

## Evaluate Sub-reasons

Files that pass through all skip rules are classified as `evaluate` with a descriptive reason:

| Reason | Condition |
|--------|-----------|
| `internal` | Has symbols, but none are exported |
| `simple` | Fewer than 3 symbols |
| `complex` | 3 or more symbols |

These sub-reasons are informational only and do not affect how the file is processed. All evaluate-tier files enter the same axis pipeline.

## Synthetic Skip Reviews

When a file is skipped, `generateSkipReview()` produces a valid `ReviewFile` with:

- `version: 2`
- `is_generated: true`
- `skip_reason`: the triage reason (e.g. `barrel-export`, `trivial`, `type-only`, `constants-only`)
- `verdict: 'CLEAN'`
- All symbols set to safe defaults: `correction: 'OK'`, `overengineering: 'LEAN'`, `utility: 'USED'`, `duplication: 'UNIQUE'`, `tests: 'NONE'`, `confidence: 100`
- Empty actions list and blank file-level notes

These synthetic reviews are written to disk and included in the final report, ensuring full coverage accounting even for trivially clean files.

## Impact on Pipeline Cost

Triage directly reduces costs by preventing LLM calls on files that would almost certainly return CLEAN verdicts. In a typical TypeScript project:

- Barrel/index files: 5-15% of all files
- Type-only and constants-only files: 10-25% of all files
- Trivial stubs: 2-5% of all files

The report's "Performance & Triage" section shows the exact skip/evaluate split and estimated time saved.

## Key Source Paths

- Triage module: `src/core/triage.ts`
- Task schema (SymbolInfo, SymbolKind): `src/schemas/task.ts`
- Review schema (ReviewFile): `src/schemas/review.ts`
