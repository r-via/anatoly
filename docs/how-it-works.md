# How Anatoly Works

Anatoly combines **tree-sitter AST parsing** with an **agentic AI review loop** powered by Claude Agent SDK. The pipeline executes in four major phases:

```
Setup ──► RAG Index ──► Review ──► Report
```

---

## Phase 1: Setup

The setup phase runs five sequential steps locally (no API calls):

### 1. Config & Dependencies

Loads `.anatoly.yml` configuration and reads `package.json` dependency metadata (`loadDependencyMeta`). Dependency versions are injected into correction prompts so the agent doesn't flag patterns that are safe in the installed library version.

### 2. Scan

Parses every matching file with **tree-sitter** (TS/TSX parser) to extract symbols — functions, classes, methods, types, constants, variables, enums, hooks — with line ranges and export status.

- Resolves files via `scan.include` / `scan.exclude` globs, filtered against `.gitignore`
- Computes SHA-256 hash per file for caching
- Generates `.anatoly/tasks/<file>.task.json` with symbol metadata
- Updates `progress.json` — files with unchanged hash are marked `CACHED` and skipped

### 3. Estimate

Counts tokens locally so you know the cost before any API call. Calculates input tokens (system prompt + file content + overhead), output tokens (base + per-symbol), and estimated wall-clock time factoring in concurrency efficiency (75%).

### 4. Triage

Classifies files to eliminate unnecessary API calls. Disabled with `--no-triage`.

| Tier | Criteria | Result |
|------|----------|--------|
| **skip** | Barrel export (0 symbols, only re-exports) | Synthetic review, no API call |
| **skip** | Trivial (< 10 lines AND <= 1 symbol) | Synthetic review, no API call |
| **skip** | Type-only (all symbols are types/enums) | Synthetic review, no API call |
| **skip** | Constants-only (all symbols are constants) | Synthetic review, no API call |
| **evaluate** | Everything else | Full LLM review |

Skipped files get a generated `ReviewFile` with `is_generated: true` — they appear in the report but cost nothing.

### 5. Usage Graph & Project Tree

- **Usage graph:** Pre-computes an import graph across all files in a single local pass (< 1s). Maps which symbols are imported where, distinguishing runtime imports from type-only imports. This data drives the utility axis — the agent no longer needs to grep for usage verification.
- **Project tree:** Builds a compact ASCII tree of the project structure (condensed to ~300 tokens). Injected into axes that benefit from structural awareness (best_practices, overengineering).

---

## Phase 2: RAG Index

Builds a semantic vector index for cross-file duplication detection. Disabled with `--no-rag`, forced rebuild with `--rebuild-rag`.

- Extracts function bodies from `.task.json` files
- Embeds code directly using `jinaai/jina-embeddings-v2-base-code` (768-dim, runs locally via `@xenova/transformers`)
- Stores vectors in LanceDB (`.anatoly/rag/lancedb/`)
- Incremental: only re-indexes files whose hash changed
- Auto-migrates if embedding dimension mismatches (e.g., after model switch)

The vector store is queried during review to find semantically similar functions for the duplication axis.

---

## Phase 3: Review

Launches concurrent file evaluations (configurable via `--concurrency`, default 4, max 10).

### Per-file evaluation

For each pending file:

1. **6 axis evaluators run in parallel** via `Promise.allSettled()`:

   | Axis | Model | What it evaluates |
   |------|-------|-------------------|
   | Utility | haiku | Dead/unused code (from usage graph) |
   | Duplication | haiku | Semantic duplication (from RAG index) |
   | Correction | sonnet | Bugs, logic errors, unsafe operations |
   | Overengineering | haiku | Unnecessary complexity |
   | Tests | haiku | Test coverage quality |
   | Best Practices | sonnet | 17 TypeGuard v2 rules (file-level, score 0-10) |

2. **Results are merged** (`mergeAxisResults`) — combines per-symbol verdicts from all 5 symbol-level axes, attaches file-level best practices, applies inter-axis coherence rules, computes the final verdict.

3. **Deliberation** (optional) — if enabled and findings exist, an Opus pass validates the merged result.

4. **Output written** — `.rev.json` review file + transcript log to the run directory.

### Crash-resilient axis pipeline

Each axis runs independently. If one crashes, the others continue. The merger injects crash sentinels for failed axes and computes the verdict from surviving axes only. Files with axis crashes are counted as `degradedReviews` in metrics.

### Self-correction loop

When an axis produces JSON output, Anatoly validates it against a strict Zod schema. If validation fails, the exact Zod errors are sent back to the agent **within the same session**, preserving the full investigation context. The agent corrects its output and resubmits, up to `max_retries` times (default: 3).

### Two-pass correction with dependency verification

The correction axis runs a **two-pass pipeline** to eliminate false positives:

1. **Pass 1** — Standard correction analysis flags `NEEDS_FIX` and `ERROR` symbols
2. **Pass 2** — A verification agent re-evaluates each finding against the **actual README documentation** of the dependencies involved (extracted from `node_modules/`). If the library handles the flagged pattern natively, the finding is downgraded to `OK`

False positives are recorded in **persistent correction memory** (`.anatoly/correction-memory.json`). On subsequent runs, known false positives are injected into the prompt so the agent avoids flagging them again.

A **contradiction detector** cross-references correction findings against best-practices results — if best-practices confirms async/error handling is correct (Rule 12 PASS) but correction flags `NEEDS_FIX`, the confidence is automatically lowered below the verdict threshold.

### Opus deliberation pass

After axes merge, an optional **deliberation pass** powered by Claude Opus validates the combined findings:

1. **Coherence check** — Verifies inter-axis findings make sense together
2. **False-positive filter** — Re-evaluates findings; downgrades incorrect ones (ERROR requires >= 95 confidence to downgrade)
3. **Confidence adjustment** — Adjusts based on cross-axis evidence
4. **Action cleanup** — Removes actions tied to invalidated findings

Enable with `llm.deliberation: true` or `--deliberation`. Skips files with high-confidence `CLEAN` verdicts (all confidences >= 70) to minimize cost.

### Error handling

- **Retry logic:** Up to 5 retries per file with exponential backoff (5-120s, 20% jitter)
- **Rate limiting:** Detected and retried transparently
- **Final failure:** File marked `ERROR` or `TIMEOUT` in progress — pipeline continues with remaining files

---

## Phase 4: Report

### Report generation

Aggregates all `.rev.json` reviews into a sharded Markdown report:

- **`report.md`** — Compact index (~100 lines) with executive summary, severity table, checkbox links to shards, and triage stats
- **`report.N.md`** — Per-shard detail files (max 10 files each), sorted by severity, with symbol-level detail tables showing all 5 axis verdicts plus confidence

If triage was enabled, the report includes estimated time saved from skipped files.

### Badge injection

If `badge.enabled` is true (default), injects or updates an audit badge in `README.md` between `<!-- checked-by-anatoly -->` markers. Optionally includes the verdict text (`--badge-verdict`). Disable with `--no-badge`.

### Run metrics

Writes `.anatoly/runs/<runId>/run-metrics.json` with:

- Total duration, cost, files reviewed, findings count
- Per-phase durations
- Per-axis stats (calls, duration, cost, tokens)
- Error breakdown by code

### Per-run log

If logging is configured, writes `.anatoly/runs/<runId>/anatoly.ndjson` with structured debug-level logs for the entire run.

---

## Claude Code Hook

Anatoly can plug directly into Claude Code as a **PostToolUse + Stop hook**, creating a real-time audit loop:

1. **Every time Claude Code edits a file**, the `PostToolUse` hook fires — Anatoly spawns a background review (debounced, SHA-checked, non-blocking)
2. **When Claude Code finishes**, the `Stop` hook fires — Anatoly collects all findings above `min_confidence` and **blocks the stop with findings as the reason**, forcing Claude Code to address them
3. **Claude Code sees the findings** and self-corrects before the user sees the result

Anti-loop protection via `max_stop_iterations` (default: 3) and Claude Code's native `stop_hook_active` flag prevents runaway iterations.

```bash
npx anatoly hook init   # generates .claude/settings.json hooks
```

---

## Output Structure

```
.anatoly/runs/<runId>/
├── report.md                    # Index with executive summary
├── report.1.md, report.2.md...  # Shards (~10 files each)
├── reviews/*.rev.json           # Machine-readable per-file reviews
├── logs/*.transcript.md         # Agent reasoning transcripts
├── run-metrics.json             # Timing, cost, error summary
└── anatoly.ndjson               # Structured debug log
```

Every finding is backed by evidence. Every review is schema-validated. The agent never guesses — it investigates.

---

See also: [Analysis Axes](analysis-axes.md) · [Configuration](configuration.md) · [Architecture](architecture.md)
