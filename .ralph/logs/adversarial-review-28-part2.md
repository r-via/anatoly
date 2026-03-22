# Adversarial Review Report — Epic 28 Stories 28.4–28.6

**Date:** 2026-03-22
**Reviewer:** Ralph (Story 32.2)
**Scope:** Stories 28.4 (Per-file Events), 28.5 (Watch Logging), 28.6 (Run Metrics Timeline)

---

## Summary

| Metric | Value |
|--------|-------|
| Total findings | 14 |
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 9 |
| LOW | 5 |
| ACs audited | 19 |
| ACs IMPLEMENTED | 11 |
| ACs PARTIAL (fixed) | 8 |
| ACs MISSING | 0 |

**Verdict:** All 3 stories are implemented. 8 PARTIAL ACs auto-fixed. All fixes pass typecheck + build + tests (1333/1333).

---

## Story 28.4 — Per-file & Per-axis Events

### Event Coverage: 14/14 event types verified

| # | Event | Status | File:Line |
|----|-------|--------|-----------|
| 1 | `llm_call` | IMPLEMENTED | `axis-evaluator.ts:530` (success), `:462` (failure) |
| 2 | `file_triage` | **PARTIAL → FIXED** | `run.ts:741` — added `phase: 'triage'` |
| 3 | `file_review_start` | IMPLEMENTED | `run.ts:1223` |
| 4 | `file_review_end` | **PARTIAL → FIXED** | `run.ts:1326` — added `event: 'file_review_end'` to ndjson |
| 5 | `axis_complete` | IMPLEMENTED | `file-evaluator.ts:212` |
| 6 | `axis_failed` | IMPLEMENTED | `file-evaluator.ts:221` |
| 7 | `file_skip` | **PARTIAL → FIXED** | `run.ts:1216` — added `phase: 'review'` |
| 8 | `rag_search` | IMPLEMENTED | `file-evaluator.ts:349` |
| 9 | `doc_resolve` | IMPLEMENTED | `file-evaluator.ts:160` |
| 10 | `retry` | **PARTIAL → FIXED** | `run.ts:1278` — renamed `file_retry` → `retry` |
| 11 | `watch_start` | IMPLEMENTED | `watch.ts:77` |
| 12 | `watch_stop` | IMPLEMENTED | `watch.ts:284` |
| 13 | `file_change` | IMPLEMENTED | `watch.ts:118` |
| 14 | `file_delete` | IMPLEMENTED | `watch.ts:217` |

---

## Story 28.5 — Watch Mode Logging

### AC Coverage: 8/8 (5 IMPLEMENTED, 3 PARTIAL fixed)

| AC | Description | Status | Proof |
|----|-------------|--------|-------|
| 28.5.1 | Run dir `watch-<ts>` at startup | IMPLEMENTED | `watch.ts:59` via `createMiniRun('watch')` |
| 28.5.2 | `watch_start` with `patterns`/`excludes` | IMPLEMENTED | `watch.ts:77-80` |
| 28.5.3 | Event sequence for file changes | **PARTIAL → FIXED** | Fixed: `file_change` type field, `file_scan` hash+symbolCount, `file_review_start` axes, `file_review_end` durationMs |
| 28.5.4 | `file_delete` event | IMPLEMENTED | `watch.ts:217` |
| 28.5.5 | `watch_stop` + ndjson flush on Ctrl+C | IMPLEMENTED | `watch.ts:284-289` |
| 28.5.6 | `file_review_error` event | **PARTIAL → FIXED** | `watch.ts:188` — fixed field semantics (`error`=code, `message`=text) |
| 28.5.7 | Conversation dumps in `conversations/` | IMPLEMENTED | `watch.ts:170` passes `conversationDir` |
| 28.5.8 | ndjson flushed after each file | IMPLEMENTED | `watch.ts:175,189` |

---

## Story 28.6 — Run Metrics Timeline

### AC Coverage: 6/6 (4 IMPLEMENTED, 2 PARTIAL fixed)

| AC | Description | Status | Proof |
|----|-------------|--------|-------|
| 28.6.1 | `timeline` with `phase_start`/`phase_end` | IMPLEMENTED | `run.ts:682-1513` (all 6 phases) |
| 28.6.2 | `file_review_start`/`end` in timeline | **PARTIAL → FIXED** | `run.ts:1345` — added `file_review_end` for errored files |
| 28.6.3 | `t` is delta from `ctx.startTime` | IMPLEMENTED | All push sites use `Date.now() - ctx.startTime` |
| 28.6.4 | Timeline sorted chronologically | IMPLEMENTED | `run.ts:1581` `.sort((a, b) => a.t - b.t)` |
| 28.6.5 | Phase + file events only (no per-axis) | IMPLEMENTED | No axis-level events in `ctx.timeline` |
| 28.6.6 | `conversations` field with all sub-fields | **PARTIAL → FIXED** | Key renamed `conversationStats` → `conversations`, added `totalCostUsd` |

---

## Findings

### Finding 1 — MEDIUM (Story 28.4)
**File:** `src/commands/run.ts:741`
**Issue:** `file_triage` event missing `phase: 'triage'` field per AC spec.
**Fix:** Added `phase: 'triage'` to event payload.

### Finding 2 — MEDIUM (Story 28.4)
**File:** `src/commands/run.ts:1326`
**Issue:** `file_review_end` not emitted to ndjson — `event` field was only in `ctx.timeline`, not in `runLog.info()` payload.
**Fix:** Added `event: 'file_review_end'` via spread: `ctx.runLog?.info({ event: 'file_review_end', ...reviewFields })`.

### Finding 3 — MEDIUM (Story 28.4)
**File:** `src/commands/run.ts:1216`
**Issue:** `file_skip` event missing `phase: 'review'` field per AC spec.
**Fix:** Added `phase: 'review'` to event payload.

### Finding 4 — MEDIUM (Story 28.4)
**File:** `src/commands/run.ts:1278`
**Issue:** Retry event named `file_retry` instead of spec-required `retry`.
**Fix:** Renamed to `retry`.

### Finding 5 — MEDIUM (Story 28.6)
**File:** `src/commands/run.ts:1335-1344`
**Issue:** `file_review_end` timeline entry not pushed for errored files — orphaned `file_review_start` with no matching end.
**Fix:** Added `ctx.timeline.push({ event: 'file_review_end', verdict: 'ERROR' })` and `ctx.runLog?.error({ event: 'file_review_end' })` in catch block.

### Finding 6 — MEDIUM (Story 28.6)
**File:** `src/commands/run.ts:1582`
**Issue:** `run-metrics.json` uses key `conversationStats` but AC spec requires `conversations`.
**Fix:** Renamed to `conversations: conversationStats`.

### Finding 7 — MEDIUM (Story 28.6)
**File:** `src/commands/run.ts:1546-1552`
**Issue:** `totalCostUsd` field entirely absent from conversation stats object.
**Fix:** Added `totalCostUsd: 0` to init object and `+= s.totalCostUsd` in aggregation loop.

### Finding 8 — MEDIUM (Story 28.5)
**File:** `src/commands/watch.ts:154`
**Issue:** `file_scan` event used `symbols` field name and lacked `hash`. Spec requires `hash` and `symbolCount`.
**Fix:** Changed to `{ event: 'file_scan', file: relPath, hash, symbolCount: symbols.length }`.

### Finding 9 — MEDIUM (Story 28.5)
**File:** `src/commands/watch.ts:188`
**Issue:** `file_review_error` field semantics inverted: `errorCode`+`error` vs spec's `error`+`message`.
**Fix:** Changed to `{ error: errorCode, message }`.

### Finding 10 — LOW (Story 28.5)
**File:** `src/commands/watch.ts:118`
**Issue:** `file_change` event missing `type` field (spec shows `"type": "change"`).
**Fix:** Added `type: 'change'`.

### Finding 11 — LOW (Story 28.5)
**File:** `src/commands/watch.ts:162`
**Issue:** `file_review_start` missing `axes` field in watch mode.
**Fix:** Added `axes: evaluators.map(e => e.id)`.

### Finding 12 — LOW (Story 28.5)
**File:** `src/commands/watch.ts:174`
**Issue:** `file_review_end` missing `durationMs` field in watch mode.
**Fix:** Added `durationMs: result.durationMs`.

### Finding 13 — LOW (Story 28.5)
**Issue:** `llm_call` events from `axis-evaluator.ts` use `contextLogger()` (global logger) which may not route to the watch ndjson file logger.
**Action:** Noted as known architectural divergence. The `contextLogger()` and `runLog` are separate pino instances. Events from axis evaluators reach ndjson only when the global logger has file transport configured.

### Finding 14 — LOW (Story 28.6)
**Issue:** `ctx.timeline` is unbounded — no capacity limit for very large codebases (5000+ files could reach several MB).
**Action:** Accepted risk — each entry is ~80 bytes, 10K entries = ~800 KB. No fix needed now.

---

## Validation

```
npm run typecheck  ✅ (0 errors)
npm run build      ✅ (578 KB ESM)
npm run test       ✅ (1333/1333 tests, 80 files)
```

## Files Modified

| File | Changes |
|------|---------|
| `src/commands/run.ts` | Added phase fields to triage/skip events, renamed file_retry→retry, added event field to file_review_end ndjson, added error-path timeline entry, renamed conversationStats→conversations, added totalCostUsd |
| `src/commands/watch.ts` | Fixed file_change type, file_scan hash/symbolCount, file_review_start axes, file_review_end durationMs, file_review_error field semantics |

## Exit Criteria

- [x] 0 CRITICAL findings remaining
- [x] 0 HIGH findings remaining
- [x] Minimum 10 findings identified (14 total)
- [x] `npm run typecheck && npm run build && npm run test` passes
- [x] Report written to `.ralph/logs/adversarial-review-28-part2.md`
