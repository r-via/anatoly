# Output Formats

Anatoly produces structured output in JSON and Markdown. This page documents the schema of each file type and the directory layout.

---

## .anatoly/ Directory Layout

After a full `anatoly run`, the `.anatoly/` directory has the following structure:

```
.anatoly/
  tasks/                         # One .task.json per scanned file
    src--core--scanner.task.json
    ...
  cache/
    progress.json                # File-level audit progress tracker
  rag/                           # LanceDB vector store for RAG
    ...
  runs/
    20260315-120000/             # Run directory (auto-generated or custom ID)
      reviews/                   # Per-file review outputs
        src--core--scanner.rev.json
        src--core--scanner.rev.md
        ...
      logs/                      # Per-file evaluation transcripts
        src--core--scanner.log
        ...
      report.md                  # Index report (links to shards)
      report.1.md                # Detail shard 1 (up to 10 files)
      report.2.md                # Detail shard 2
      ...
      run-metrics.json           # Run-level metrics and cost data
      anatoly.ndjson             # Per-run structured log
  progress.json                  # Legacy progress file
  anatoly.lock                   # Process lock (present during active runs)
```

File names use a path-encoding scheme: forward slashes in the source path are replaced with `--`. For example, `src/core/scanner.ts` becomes `src--core--scanner`.

---

## Per-File Review (.rev.json)

Each reviewed file produces a `.rev.json` file containing the full structured review. The schema is defined in `src/schemas/review.ts` as `ReviewFileSchema`.

### Top-level fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | `1 \| 2` | Schema version. Version 2 adds `best_practices` and `axis_meta`. |
| `file` | string | Relative path of the reviewed file. |
| `is_generated` | boolean | Whether the file was detected as generated code. |
| `skip_reason` | string? | Reason the file was skipped by triage (present when `is_generated` is true). |
| `verdict` | `CLEAN \| NEEDS_REFACTOR \| CRITICAL` | File-level verdict. |
| `symbols` | SymbolReview[] | Per-symbol analysis results. |
| `actions` | Action[] | Recommended actions sorted by severity. |
| `file_level` | FileLevel | File-level notes (unused imports, circular deps, general notes). |
| `best_practices` | BestPractices? | File-level best practices evaluation (v2 only). |
| `axis_meta` | Record\<AxisId, AxisMetaEntry\>? | Per-axis cost and timing metadata (v2 only). |

### SymbolReview

Each symbol (function, class, method, type, constant, variable, enum, hook) receives independent ratings across five axes:

| Field | Type | Values |
|-------|------|--------|
| `name` | string | Symbol name |
| `kind` | enum | `function`, `class`, `method`, `type`, `constant`, `variable`, `enum`, `hook` |
| `exported` | boolean | Whether the symbol is exported |
| `line_start` | integer | Starting line number (1-based) |
| `line_end` | integer | Ending line number (1-based) |
| `correction` | enum | `OK`, `NEEDS_FIX`, `ERROR` |
| `overengineering` | enum | `LEAN`, `OVER`, `ACCEPTABLE` |
| `utility` | enum | `USED`, `DEAD`, `LOW_VALUE` |
| `duplication` | enum | `UNIQUE`, `DUPLICATE` |
| `tests` | enum | `GOOD`, `WEAK`, `NONE` |
| `confidence` | integer | 0--100, reliability of the assessment |
| `detail` | string | Pipe-delimited per-axis explanation (min 10 chars) |
| `duplicate_target` | object? | `{ file, symbol, similarity }` when duplication is `DUPLICATE` |

### Action

| Field | Type | Values |
|-------|------|--------|
| `id` | integer | Sequential action ID (1-based) |
| `description` | string | What to do |
| `severity` | enum | `high`, `medium`, `low` |
| `effort` | enum | `trivial`, `small`, `large` |
| `category` | enum | `quickwin`, `refactor`, `hygiene` |
| `source` | enum? | Originating axis: `utility`, `duplication`, `correction`, `overengineering`, `tests`, `best_practices` |
| `target_symbol` | string? | Symbol the action targets |
| `target_lines` | string? | Line range (e.g., `L42-L58`) |

### FileLevel

| Field | Type | Description |
|-------|------|-------------|
| `unused_imports` | string[] | List of unused import specifiers |
| `circular_dependencies` | string[] | Detected circular dependency chains |
| `general_notes` | string | Free-form file-level observations |

### BestPractices (v2)

| Field | Type | Description |
|-------|------|-------------|
| `score` | number | 0--10, starting at 10 with penalties per rule violation |
| `rules` | BestPracticesRule[] | Per-rule evaluation (17 rules) |
| `suggestions` | BestPracticesSuggestion[] | Concrete before/after improvement suggestions |

Each rule has: `rule_id` (1--17), `rule_name`, `status` (`PASS`, `WARN`, `FAIL`), `severity` (`CRITICAL`, `HIGH`, `MEDIUM`), optional `detail` and `lines`.

### AxisMetaEntry (v2)

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | LLM model used for this axis |
| `cost_usd` | number | API cost in USD |
| `duration_ms` | number | Wall-clock evaluation time |

### Example

```json
{
  "version": 2,
  "file": "src/core/scanner.ts",
  "is_generated": false,
  "verdict": "NEEDS_REFACTOR",
  "symbols": [
    {
      "name": "parseFile",
      "kind": "function",
      "exported": true,
      "line_start": 15,
      "line_end": 82,
      "correction": "OK",
      "overengineering": "LEAN",
      "utility": "USED",
      "duplication": "UNIQUE",
      "tests": "GOOD",
      "confidence": 88,
      "detail": "[USED] Imported by 4 files | [UNIQUE] No similar functions found | [OK] Logic is correct | [LEAN] Appropriate complexity | [GOOD] Covered by scanner.test.ts",
      "duplicate_target": null
    },
    {
      "name": "legacyHelper",
      "kind": "function",
      "exported": true,
      "line_start": 84,
      "line_end": 95,
      "correction": "OK",
      "overengineering": "LEAN",
      "utility": "DEAD",
      "duplication": "UNIQUE",
      "tests": "NONE",
      "confidence": 92,
      "detail": "[DEAD] Exported but imported by 0 files | [UNIQUE] No duplicates | [OK] No bugs | [LEAN] Simple | [NONE] No tests (dead code)",
      "duplicate_target": null
    }
  ],
  "actions": [
    {
      "id": 1,
      "description": "Remove unused exported function",
      "severity": "medium",
      "effort": "trivial",
      "category": "quickwin",
      "source": "utility",
      "target_symbol": "legacyHelper",
      "target_lines": "L84-L95"
    }
  ],
  "file_level": {
    "unused_imports": [],
    "circular_dependencies": [],
    "general_notes": ""
  },
  "best_practices": {
    "score": 9,
    "rules": [
      { "rule_id": 9, "rule_name": "JSDoc on public exports", "status": "WARN", "severity": "MEDIUM", "detail": "legacyHelper missing JSDoc" }
    ],
    "suggestions": [
      { "description": "Add JSDoc to exported function legacyHelper" }
    ]
  }
}
```

---

## Per-File Review (.rev.md)

The `.rev.md` file is a human-readable Markdown rendering of the same data as `.rev.json`. It is generated automatically alongside the JSON file.

### Structure

1. **Header** -- File path, verdict, and generated-file indicator.
2. **Symbols table** -- All symbols with their axis ratings and confidence in a Markdown table.
3. **Details** -- Per-symbol breakdown with structured per-axis explanations parsed from the pipe-delimited `detail` string. Each axis is rendered as a bullet point with the rating value and explanation.
4. **Best Practices** -- Score, failing rules table (WARN/FAIL only), and concrete before/after suggestions.
5. **Actions** -- Grouped by category (Quick Wins, Refactors, Hygiene) with severity, effort, and target information.
6. **File-Level Notes** -- Unused imports, circular dependencies, and general observations.

---

## Sharded Report Structure

The `report` command (and the report phase of `run`) produces a sharded Markdown report designed to stay compact even for large codebases.

### Index (report.md)

The index file is always named `report.md` and contains:

1. **Executive Summary** -- Total files, global verdict, clean/finding/error/degraded counts.
2. **Severity Table** -- Findings broken down by category (Correction, Utility, Duplicates, Over-engineering) and severity (High, Medium, Low).
3. **Shards** -- A checklist of links to detail shard files (`report.1.md`, `report.2.md`, etc.), each annotated with the number of files and a composition summary (e.g., "2 CRITICAL, 3 NEEDS_REFACTOR").
4. **Files in Error** -- List of files that failed during review (API errors, timeouts).
5. **Degraded Reviews** -- Files where axis evaluators crashed, producing potentially unreliable results.
6. **Performance & Triage** -- Skip/evaluate tier breakdown and estimated time saved (only when triage was active).
7. **Methodology** -- Axis reference, rating criteria, severity classification rules, verdict rules, and inter-axis coherence rules.

### Detail Shards (report.N.md)

Each shard contains at most **10 files**, sorted by severity:

1. CRITICAL files first, then NEEDS_REFACTOR, then by finding count (descending), then by max confidence (descending).

Each shard includes:

1. **Findings table** -- One row per file with verdict, per-axis finding counts, best practices score, max confidence, and a link to the detailed `.rev.md`.
2. **Symbol Details** -- For files with actionable findings: a per-symbol table showing all axis ratings for symbols with confidence >= 30.
3. **Quick Wins / Refactors / Hygiene** -- Actions grouped by category, scoped to the shard's files.
4. **Best Practices** -- Files with suggestions, including before/after code examples.

### Example shard link from index

```markdown
- [ ] [report.1.md](./report.1.md) (10 files -- 2 CRITICAL, 8 NEEDS_REFACTOR)
- [ ] [report.2.md](./report.2.md) (6 files -- 6 NEEDS_REFACTOR)
```

---

## run-metrics.json

Written at the end of each `run` into the run directory. Contains aggregate performance data.

| Field | Type | Description |
|-------|------|-------------|
| `runId` | string | Run identifier |
| `durationMs` | number | Total wall-clock time |
| `filesReviewed` | integer | Number of files reviewed |
| `findings` | integer | Total findings count |
| `errors` | integer | Number of files that errored |
| `errorsByCode` | Record\<string, number\> | Error counts grouped by error code |
| `degradedReviews` | integer | Files with axis crashes |
| `costUsd` | number | Total LLM API cost in USD |
| `phaseDurations` | Record\<string, number\> | Per-phase wall-clock time in ms (scan, estimate, rag-index, review, report) |
| `axisStats` | Record\<string, AxisStats\> | Per-axis aggregate: calls, totalDurationMs, totalCostUsd, totalInputTokens, totalOutputTokens |

---

## README Badge

When `badge.enabled` is true in config (and `--no-badge` is not set), the `run` command injects a shields.io badge into `README.md`.

### Badge markup

The badge is wrapped in HTML comment markers for idempotent updates:

```markdown
<!-- checked-by-anatoly -->
[![Checked by Anatoly](https://img.shields.io/badge/checked%20by-Anatoly-blue)](https://github.com/r-via/anatoly)
<!-- /checked-by-anatoly -->
```

With `--badge-verdict` (or `badge.verdict: true` in config), the badge includes the verdict with color coding:

| Verdict | Color | Label |
|---------|-------|-------|
| CLEAN | brightgreen | clean |
| NEEDS_REFACTOR | yellow | needs refactor |
| CRITICAL | red | critical |

### Behavior

- On first injection, the badge block is appended to the end of `README.md`.
- On subsequent runs, the existing block (identified by the comment markers) is replaced in place.
- The badge links to `badge.link` from config, defaulting to `https://github.com/r-via/anatoly`.
- If `README.md` does not exist or is not writable, badge injection is silently skipped.

---

## Per-Run Log (anatoly.ndjson)

Each run writes a structured ndjson log at `.anatoly/runs/<run-id>/anatoly.ndjson`. This log captures phase start/complete events, per-file review completions (with verdict, cost, tokens, duration), error events, and the final run summary. Useful for debugging and cost analysis.
