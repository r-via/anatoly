# Changelog

## [0.5.0] - 2026-03-15

### Features

- **`anatoly fix <report-file>`** — New command that parses audit report shards and generates Ralph artifacts (prd.json, CLAUDE.md, ralph.sh) for autonomous code remediation ([Epic 25](docs/05-Integration/02-CI-CD.md))
- **`anatoly fix-sync <report-file>`** — New command that syncs completed fixes back to the audit report via deterministic `<!-- ACT-{hash}-{id} -->` checkbox matching
- **Checkbox rendering in reports** — Every action in audit report shards now includes a `- [ ]` checkbox with a unique HTML comment ID, plus an aggregated Checklist section in the report index
- **Targeted README section extraction** — Correction verification pass now reads actual dependency READMEs for evidence

### Fixes

- **`--file` filter scoping** — Estimate and triage phases now correctly scope to matching files when `--file` is active, fixing misleading token/time estimates
- **Dead FunctionCard fields removed** — `rag-status` no longer displays `summary`, `keyConcepts`, `behavioralProfile` fields that were never populated
- **maxTurns bump** — Increased from 1 to 2 to prevent `error_max_turns` on double assistant messages

### Documentation

- **Complete documentation restructure** — 27 files organized into 7 thematic sections (Getting Started, Architecture, CLI Reference, Core Modules, Integration, Development, Design Decisions)
- **Cross-referenced against source code** — All docs reviewed for factual accuracy with 32 corrections applied
- **README updated** — New doc table, Anatoly Shmondenko origin story, fixed dead links and fabricated flags

### Internal

- Removed 9 legacy flat doc files superseded by the new structure
- Updated `.ralph/fix_plan.md` with Epic 25 stories

---

## [0.4.2] - 2026-03-08

### Features

- Code-direct embedding model (Jina V2 Base Code, 768-dim) replacing text embedding for RAG pipeline (Epic 24)
- Similarity threshold calibration for code embeddings
- Structured pino logging with AsyncLocalStorage context (Epic 23)
- Per-run ndjson log files and run-metrics.json
- README badge injection after successful audit (Epic 22)
- Opus deliberation pass for post-merge validation
- Two-pass correction with dependency verification and false-positive memory
- Real-time transcript streaming and symbol-level report details
- Watch mode with initial scan, report regen, and lock management

### Fixes

- Hardened axis pipeline with validation, safety guards, and confidence filtering
- Hardened crash handling with confidence 0, degraded report section
- Badge injection with lock scope, nullish coalescing, and URL encoding
- `$NO_COLOR` env var support for accessibility compliance
- Enforce single-turn no-tools mode via system prompt directive
- Clean up Epic 24 dead code and stale references

### Refactoring

- Extract 6 axis system prompts to dedicated Markdown files
- Extract shared review display into review-display.ts
- Rename LLM_* error codes to SDK_*
