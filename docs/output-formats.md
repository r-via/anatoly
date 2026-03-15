# Output Formats

Anatoly produces several output files per audit run. All outputs are written to `.anatoly/runs/<runId>/`.

## Table of Contents

- [`.rev.json` — Machine-Readable Review](#revjson--machine-readable-review)
- [`.rev.md` — Human-Readable Review](#revmd--human-readable-review)
- [`report.md` — Index Report](#reportmd--index-report)
- [`report.N.md` — Shard Reports](#reportnmd--shard-reports)
- [`run-metrics.json` — Run Statistics](#run-metricsjson--run-statistics)
- [Transcript Logs](#transcript-logs)
- [`anatoly.ndjson` — Structured Run Log](#anatolyndjson--structured-run-log)
- [README Badge](#readme-badge)
- [File Naming](#file-naming)

---

## `.rev.json` — Machine-Readable Review

**Location:** `<runDir>/reviews/<outputName>.rev.json`

Zod-validated JSON (see [Schemas](schemas.md) for the full `ReviewFile` definition). Example:

```json
{
  "version": 2,
  "file": "src/commands/estimate.ts",
  "is_generated": false,
  "verdict": "NEEDS_REFACTOR",
  "symbols": [
    {
      "name": "registerEstimateCommand",
      "kind": "function",
      "exported": true,
      "line_start": 8,
      "line_end": 42,
      "correction": "OK",
      "overengineering": "LEAN",
      "utility": "USED",
      "duplication": "UNIQUE",
      "tests": "NONE",
      "confidence": 95,
      "detail": "[USED] Exported, imported by src/commands/index.ts | [UNIQUE] No similar functions | [OK] No bugs | [LEAN] Minimal | [NONE] No tests found",
      "duplicate_target": null
    }
  ],
  "actions": [
    {
      "id": 1,
      "description": "Add unit tests for estimate command",
      "severity": "medium",
      "effort": "small",
      "category": "hygiene",
      "source": "tests",
      "target_symbol": "registerEstimateCommand",
      "target_lines": "L8-L42"
    }
  ],
  "file_level": {
    "unused_imports": [],
    "circular_dependencies": [],
    "general_notes": ""
  },
  "best_practices": {
    "score": 8.5,
    "rules": [
      { "rule_id": 1, "rule_name": "Strict mode", "status": "PASS", "severity": "HAUTE" },
      { "rule_id": 2, "rule_name": "No any", "status": "WARN", "severity": "CRITIQUE", "detail": "program.opts() implicit any", "lines": "L15" }
    ],
    "suggestions": [
      {
        "description": "Use Commander generic opts<T>()",
        "before": "const opts = program.opts();",
        "after": "const opts = program.opts<{ config?: string }>();"
      }
    ]
  },
  "axis_meta": {
    "utility": { "model": "claude-haiku-4-5", "cost_usd": 0.001, "duration_ms": 1200 },
    "correction": { "model": "claude-sonnet-4-6", "cost_usd": 0.004, "duration_ms": 2100 }
  }
}
```

**Key details:**
- `version: 2` includes `best_practices` and `axis_meta` (v1 omits them)
- `is_generated: true` for triage-skipped files (synthetic review, zero API cost)
- `symbols[].detail` uses pipe-delimited format: `[VERDICT] explanation | ...`
- `duplicate_target` is `null` unless `duplication = DUPLICATE`

---

## `.rev.md` — Human-Readable Review

**Location:** `<runDir>/reviews/<outputName>.rev.md`

Rendered Markdown of the same data as `.rev.json`:

- **Symbols table** — all symbols with their 5 axis verdicts and confidence
- **Details per symbol** — per-axis explanations, duplicate targets as blockquotes
- **Best Practices** — score, WARN/FAIL rules only (PASS hidden), code suggestions with before/after
- **Actions** — grouped by category: Quick Wins, Refactors, Hygiene
- **File-Level Notes** — unused imports, circular dependencies

---

## `report.md` — Index Report

**Location:** `<runDir>/report.md`

Compact index (~100 lines) with:

### Sections

1. **Executive Summary** — files reviewed, global verdict, clean/finding/error counts, degraded review count

2. **Severity Table** — finding counts by category and severity:

   | Category | High | Medium | Low | Total |
   |----------|------|--------|-----|-------|
   | Correction errors | 5 | 12 | 8 | 25 |
   | Utility | 2 | 8 | 15 | 25 |
   | Duplicates | 1 | 4 | 2 | 7 |
   | Over-engineering | 0 | 6 | 18 | 24 |

3. **Shard Links** — checkbox-style links to `report.N.md` files with file counts and verdict breakdown

4. **Files in Error** — files that failed evaluation (SDK errors, timeouts)

5. **Degraded Reviews** — files where one or more axis evaluators crashed

6. **Triage Stats** — skip/evaluate tier breakdown with estimated time saved

7. **Methodology** — axis reference table, severity classification, verdict rules, inter-axis coherence rules

### Severity Classification

| Level | Condition |
|-------|-----------|
| High | `ERROR` corrections, or `NEEDS_FIX`/`DEAD`/`DUPLICATE` with confidence >= 80 |
| Medium | `NEEDS_FIX`/`DEAD`/`DUPLICATE` with confidence < 80, or `OVER` (any confidence) |
| Low | `LOW_VALUE` utility or remaining minor findings |

---

## `report.N.md` — Shard Reports

**Location:** `<runDir>/report.1.md`, `report.2.md`, etc.

Each shard contains up to **10 files** (constant: `SHARD_SIZE = 10`), sorted by severity (CRITICAL first, then NEEDS_REFACTOR, then by finding count descending).

### Sections per shard

1. **Findings Table** — file-level summary with verdict, finding counts per axis, best practices score, confidence, link to `.rev.md`

2. **Symbol Details** — per-file table showing each symbol's name, line range, and all 5 axis verdicts plus confidence

3. **Actions** — grouped by category, scoped to files in this shard:
   - **Quick Wins** — trivial effort, high-value fixes
   - **Refactors** — medium effort improvements
   - **Hygiene** — low-priority cleanup

4. **Best Practices** — suggestions with before/after code examples (only for files that have suggestions)

---

## `run-metrics.json` — Run Statistics

**Location:** `<runDir>/run-metrics.json`

```json
{
  "runId": "2026-03-15_142345",
  "durationMs": 45230,
  "filesReviewed": 125,
  "findings": 87,
  "errors": 2,
  "errorsByCode": {
    "SDK_TIMEOUT": 1,
    "RATE_LIMITED": 1
  },
  "degradedReviews": 2,
  "costUsd": 3.45,
  "phaseDurations": {
    "scan": 1200,
    "estimate": 800,
    "rag-index": 8500,
    "review": 32000,
    "report": 2730
  },
  "axisStats": {
    "utility": {
      "calls": 125,
      "totalDurationMs": 6250,
      "totalCostUsd": 0.625,
      "totalInputTokens": 312500,
      "totalOutputTokens": 62500
    },
    "correction": {
      "calls": 125,
      "totalDurationMs": 12500,
      "totalCostUsd": 1.875,
      "totalInputTokens": 625000,
      "totalOutputTokens": 187500
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `runId` | string | Run identifier (timestamp or custom `--run-id`) |
| `durationMs` | number | Total pipeline duration |
| `filesReviewed` | number | Files that received LLM evaluation |
| `findings` | number | Total findings with confidence >= 60 |
| `errors` | number | Files that failed evaluation |
| `errorsByCode` | object | Error breakdown by code (`SDK_TIMEOUT`, `SDK_ERROR`, etc.) |
| `degradedReviews` | number | Files where one or more axes crashed |
| `costUsd` | number | Total LLM API cost |
| `phaseDurations` | object | Per-phase wall-clock time in ms |
| `axisStats` | object | Per-axis aggregated calls, duration, cost, and tokens |

---

## Transcript Logs

**Location:** `<runDir>/logs/<outputName>.log`

Plain text transcripts of each axis evaluation, streamed as axes complete:

```
# Axis: utility

## Symbol: registerEstimateCommand (L8–L42)

**Rating:** USED
**Confidence:** 95%

Exported function imported at runtime by src/commands/index.ts.

---

# Axis: correction

## Symbol: registerEstimateCommand (L8–L42)

**Rating:** OK
**Confidence:** 95%

No correctness issues detected.

---
```

Each axis section is separated by `---`. Failed axes show: `# Axis: <name> — FAILED` with the error message.

If deliberation ran, a `# Deliberation Pass` section is appended with the re-evaluation reasoning.

---

## `anatoly.ndjson` — Structured Run Log

**Location:** `<runDir>/anatoly.ndjson`

Newline-delimited JSON with debug-level structured events:

```jsonl
{"level":"info","runId":"2026-03-15_142345","message":"run started","timestamp":"..."}
{"level":"info","phase":"scan","filesScanned":125,"message":"phase completed","timestamp":"..."}
{"level":"debug","file":"src/utils/format.ts","verdict":"CLEAN","costUsd":0.002,"message":"file review completed","timestamp":"..."}
{"level":"info","totalDurationMs":45230,"totalCostUsd":3.45,"message":"run completed","timestamp":"..."}
```

Use `jq` to analyze (see [Logging](logging.md) for recipes).

---

## README Badge

Injected between `<!-- checked-by-anatoly -->` markers in `README.md`:

| Verdict | Badge Color | Example |
|---------|-------------|---------|
| (no verdict) | blue | `[![Checked by Anatoly](https://img.shields.io/badge/checked%20by-Anatoly-blue)]` |
| CLEAN | brightgreen | `checked by — Anatoly — clean` |
| NEEDS_REFACTOR | yellow | `checked by — Anatoly — needs refactor` |
| CRITICAL | red | `checked by — Anatoly — critical` |

Enable verdict text with `--badge-verdict` or `badge.verdict: true`. Disable badge entirely with `--no-badge`.

---

## File Naming

Output files use a sanitized name derived from the source path:

```
src/utils/format.ts  →  src-utils-format.rev.json
src/core/axes/utility.ts  →  src-core-axes-utility.rev.json
```

The `toOutputName()` function removes the file extension and replaces all `/` and `\` with `-`.

---

See also: [Schemas](schemas.md) · [Configuration](configuration.md) · [How It Works](how-it-works.md)
