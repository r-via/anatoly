# Reporter

The reporter (`src/core/reporter.ts`) and review writer (`src/core/review-writer.ts`) are responsible for turning raw review JSON into human-readable Markdown. The reporter generates the sharded aggregate report; the review writer produces per-file review documents. Badge injection into README.md is handled by `src/core/badge.ts`.

## Report Architecture

The report system produces three levels of output:

```
.anatoly/runs/<runId>/
  report.md              Index (executive summary, shard links)
  report.1.md            Shard 1 (up to 10 files with findings)
  report.2.md            Shard 2
  ...
  reviews/
    src--core--scanner.rev.json    Per-file review (JSON)
    src--core--scanner.rev.md      Per-file review (Markdown)
```

When a run directory is provided, all output is scoped under that directory instead of `.anatoly/`.

## Sharded Report Generation

### Why Sharding

Reports are split into shards of at most 10 files each (`SHARD_SIZE = 10`). This keeps individual report files manageable for both human readers and LLM consumers that may process the reports downstream.

### Generation Flow

`generateReport()` executes the following steps:

1. **Load reviews**: Read all `.rev.json` files from the reviews directory, parse and validate each with `ReviewFileSchema`.
2. **Aggregate**: `aggregateReviews()` classifies files, counts findings by severity, and collects actions.
3. **Build shards**: `buildShards()` sorts finding files by severity then splits them into shard groups.
4. **Write index**: `renderIndex()` produces `report.md`.
5. **Write shards**: `renderShard()` produces `report.N.md` for each shard.

### Sorting Logic

Finding files are sorted with the most critical issues first:

1. CRITICAL verdict before NEEDS_REFACTOR before CLEAN.
2. Within the same verdict, files with more actionable findings come first.
3. Ties are broken by maximum confidence (descending).

## Index Report (`report.md`)

The index contains:

### Executive Summary

- Files reviewed, global verdict, clean count, findings count.
- Error files and degraded reviews (from axis crashes) if any.

### Severity Table

A matrix of finding counts by category and severity:

| Category | High | Medium | Low | Total |
|----------|------|--------|-----|-------|
| Correction errors | ... | ... | ... | ... |
| Utility (dead code) | ... | ... | ... | ... |
| Duplicates | ... | ... | ... | ... |
| Over-engineering | ... | ... | ... | ... |

Rows are only shown when at least one finding exists for that category.

### Shard Links

Checklist-style links to each shard file with composition details (e.g. "2 CRITICAL, 3 NEEDS_REFACTOR").

### Performance and Triage

When triage statistics are provided, a table shows the skip/evaluate split with percentages and estimated time saved.

### Methodology

A comprehensive reference section documenting:
- The 6-axis evaluation model.
- Rating criteria and values for each axis.
- The 17 best practices rules with severity and penalty values.
- Severity classification rules (high/medium/low).
- Verdict rules (CLEAN/NEEDS_REFACTOR/CRITICAL).
- Inter-axis coherence rules.

## Shard Reports (`report.N.md`)

Each shard contains:

### Findings Table

A summary table with one row per file showing verdict, count of dead/duplicate/over-engineered/error symbols, best practices score, max confidence, and a link to the detailed review.

### Symbol Details

For files with actionable findings, a per-symbol table showing all axis ratings and confidence for each flagged symbol.

### Actions by Category

Actions are grouped into three categories:

| Category | Description |
|----------|-------------|
| `quickwin` | Low-effort fixes with high impact |
| `refactor` | Larger changes requiring design decisions |
| `hygiene` | Cleanup tasks (unused imports, naming) |

Each action includes severity, effort estimate, description, target symbol, and line reference.

### Best Practices

Files with best practices suggestions are listed with their score and specific before/after code recommendations.

## Per-File Reviews

The review writer (`src/core/review-writer.ts`) produces two files for each reviewed file:

### `.rev.json`

The raw `ReviewFile` object written atomically via `atomicWriteJson()`. This is the source of truth consumed by the reporter.

### `.rev.md`

A human-readable Markdown document rendered by `renderReviewMarkdown()` containing:

1. **Header**: File path, verdict, and skip status.
2. **Symbols table**: All symbols with their axis ratings and confidence.
3. **Symbol details**: Per-symbol breakdown with structured axis segments. The detail string uses a pipe-delimited format (`[VALUE] explanation | [VALUE] explanation`) which `parseDetailSegments()` decomposes into individual axis results. For axes that did not produce results, a "default" annotation is shown.
4. **Best practices**: Score, failing rules table, and suggestions with before/after code.
5. **Actions**: Grouped by category (quickwin, refactor, hygiene).
6. **File-level notes**: Unused imports, circular dependencies, and general notes.

### Transcripts

`writeTranscript()` saves the raw LLM conversation log for each file to `.anatoly/logs/` (or the run-scoped logs directory). These are useful for debugging axis evaluator behaviour.

## Verdict Computation

The reporter uses `computeFileVerdict()` to standardise verdicts from symbols rather than trusting the LLM's verdict directly:

- Findings with confidence < 30 are discarded entirely (in `aggregateReviews()`, before verdict computation).
- Findings with confidence < 60 are excluded from verdict computation.
- `tests: NONE` alone never triggers NEEDS_REFACTOR.

`computeGlobalVerdict()` takes the worst verdict across all files.

## Severity Classification

Each symbol finding is classified by `symbolSeverity()`:

| Severity | Condition |
|----------|-----------|
| High | ERROR correction, or NEEDS_FIX/DEAD/DUPLICATE with confidence >= 80 |
| Medium | NEEDS_FIX/DEAD/DUPLICATE with lower confidence, or OVER at any confidence |
| Low | LOW_VALUE utility, or remaining minor findings |

## Badge Injection

The badge module (`src/core/badge.ts`) injects a shields.io badge into `README.md`:

### Badge Variants

| Variant | When |
|---------|------|
| Generic blue | `includeVerdict` is false |
| Verdict-coloured | `includeVerdict` is true -- green (CLEAN), yellow (NEEDS_REFACTOR), red (CRITICAL) |

### Injection Mechanism

The badge is wrapped in HTML comment markers:

```html
<!-- checked-by-anatoly -->
[![Checked by Anatoly](https://img.shields.io/badge/...)](https://github.com/r-via/anatoly)
<!-- /checked-by-anatoly -->
```

On first injection, the block is appended to the end of the README. On subsequent runs, the existing block is replaced in place using a regex match on the markers. The badge links to the Anatoly repository by default, configurable via the `link` option.

If the README does not exist or is not writable, badge injection is silently skipped.

## Key Source Paths

- Reporter: `src/core/reporter.ts`
- Review writer: `src/core/review-writer.ts`
- Badge: `src/core/badge.ts`
- Cache utilities (toOutputName, atomicWriteJson): `src/utils/cache.ts`
- Review schema: `src/schemas/review.ts`
