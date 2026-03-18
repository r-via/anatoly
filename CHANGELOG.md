# Changelog

## [0.6.0] - 2026-03-18

### Features

- **Documentation axis (7th axis)** — evaluates JSDoc coverage on exports and /docs/ synchronization (`DOCUMENTED` / `PARTIAL` / `UNDOCUMENTED` verdicts) — Epic 26
- **Deliberation memory** — generalize correction memory into deliberation memory covering all axes, persistent across runs
- **Deliberation feeds learning loop** — deliberation results now feed back into correction memory for continuous improvement
- **Calibrated ETA** — `estimate` and pipeline summary display calibrated per-axis timing based on historical runs
- **Branch isolation** — `clean-run` enforces branch isolation before launching the Ralph loop
- **Run lock** — block concurrent commands while a run is in progress
- **Dry-run improvements** — phase-based estimate, calibrated per-axis timing, skip runDir creation in dry-run mode
- **NIH detection** — overengineering axis detects Not Invented Here patterns
- **Holistic deliberation** — deliberation covers all axes per symbol holistically with transitive usage-graph refs
- **Tests axis enrichment** — test file content, callers, and project tree injected into tests axis context
- **Run Statistics & Axis Summary** — new report sections for run metrics and per-axis verdict distribution
- **`init` & `setup-embeddings` commands** — one-command project setup and GPU embedding installation
- **`--dry-run` mode** — simulate scan, estimate, triage without API calls
- **`--axes` CLI option** — run specific axes (e.g. `--axes correction,tests`)
- **RAG observability** — `rag-status` shows both lite+advanced indexes with correct dimensions
- **Sentence-transformers sidecar** — replace Ollama with sentence-transformers for GPU-accelerated embeddings (nomic-embed-code 7B, 3584d)
- **Dual code+NLP embedding** — hybrid similarity search with configurable code/NLP weight
- **Hardware detection** — auto-select embedding models based on available hardware (RAM, GPU)
- **Demo GIF** — animated demo in README

### Fixes

- **Documentation axis** — default median calibration (60s/file), merge pipeline integration, prefix matching, memory logging
- **Adversarial review** — wire docsTree, fix 6→7-axis refs
- **Accumulative cache** — cached reviews copied into current runDir for complete reports
- **Best practices** — FAILs now count as findings and trigger NEEDS_REFACTOR
- **Tests axis** — findings trigger NEEDS_REFACTOR, path safety, confidence filter, usageGraph access fix
- **Calibration** — use max(axis) for parallel model, remove 3s sleep, cap runs
- **Deliberation** — only reviews symbols with findings, skips clean ones; always active by default
- **Report** — hide non-executed axes, show full deliberation reasoning (remove 120-char truncation)
- **RAG** — resolve Arrow FloatVector crash, ONNX fallback always uses Jina
- **Severity labels** — replace French labels with English (CRITIQUE→CRITICAL, HAUTE→HIGH, MOYENNE→MEDIUM)
- **Sidecar** — loading progress spinner, correct model dimensions, venv isolation

### Licensing

- **AGPL-3.0** — migrate from Apache-2.0 to AGPL-3.0
- **Dual-licensing framework** — add commercial license option with CLA

### Refactoring

- Rename hook subcommands to `on-edit`/`on-stop`
- Rename `fix`/`fix-sync` commands to `clean`/`clean-sync`
- Remove auto-migration from VectorStore, add `initReadOnly`
- Replace `--dual-embedding` with `--rag-lite` / `--rag-advanced`

---

## [0.5.1] - 2026-03-15

### Features

- Colored MOTD banner at startup
- Sidecar lifecycle overhaul — cleanup, scoped spawn, idle timeout
- Show RAG file count in setup summary table
- List available axes in `--axes` help text
- Auto-disable dual embedding when nomic-7B sidecar is active
- Show sidecar loading progress in CLI spinner with elapsed time
- Harden Ralph clean loop with circuit breaker, anti-placeholder guards, and adaptive PRD

### Fixes

- Resolve pre-existing TypeScript compilation errors
- Review progress counter matches triage evaluate count
- Exclude NLP-failed cards from cache so they get retried
- Purge RAG cache when vector store is empty
- Remove Arrow table migration — drop legacy table instead
- ONNX fallback always uses Jina, not the sidecar model
- Correct nomic-embed-code dimension to 3584d
- Use correct model ID `nomic-ai/nomic-embed-code`
- Move embedding venv to `.anatoly/.venv` to avoid project collision

### Refactoring

- Simplify estimate and triage CLI output
- Replace `--dual-embedding` with `--rag-lite` / `--rag-advanced`

---

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
