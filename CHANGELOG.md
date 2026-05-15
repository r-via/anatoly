# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Lite-mode documentation is now per-file RAG retrieval.** In `documentation.internal.mode: lite`, reference docs reach the `correction`, `best-practices`, and `overengineering` axes through targeted RAG lookups at review time: for each file, Anatoly retrieves the most relevant doc-section chunks, expands each to its H2 neighbourhood (matched section + previous + next), and injects them as authoritative ground truth. No upfront artefact, no token budget, no truncation; the retrieval is deterministic (cosine similarity, no LLM) and scales to any doc corpus size. Reference docs are treated as correct and current in lite mode (code/doc drift is flagged as `doc_divergence` against the code). Use `mode: full` when docs may be stale and you want 3-way arbitration instead.
- **`documentation.internal.lite` has no sub-config.** `mode: lite` is sufficient. The removed digest-era fields (`max_tokens`, `refresh_on`, `on_overflow`) no longer exist.
- **RAG query observability.** Every vector-store search (`search`, `searchById`, `searchByIdHybrid`, `searchByNlpVector`, `searchDocSections`) emits a structured `rag.query` event into `.anatoly/runs/<runId>/anatoly.ndjson`: caller, axis, file, query parameters, latency, result count, top hit. The retrieval chain of any run is now fully traceable by grepping `rag_query`.
- **Reference-doc indexing follows `reference.paths` exactly.** The doc indexer enumerates the configured globs directly, so root-level files like `README.md` (outside any single `docsDir`) are now indexed and retrievable.
- **In-flight run visibility (Epic 53):** `anatoly attach [runId]` command for live read-only viewing of running audits
  - Auto-selects the only active run, or specify a run ID explicitly
  - ndjson tail with `--from-start` replay and real-time TUI rendering (phases, progress bar, findings)
  - Clean termination: exits with correct codes for done/failed/crashed/SIGINT
  - Crash detection: polls PID liveness, auto-marks crashed runs in `run-status.json`
  - Read-only safety: attach never writes to the run's ndjson log (NFR5)
- **Foreground run-status.json (Story 53.1):** `run-status.json` is written at the start of foreground runs, making them visible to `anatoly status` immediately
- **Progress path fix (Story 53.2):** `anatoly status` now reads `progress.json` from the correct `.anatoly/cache/` path
- **Active run highlighting (Story 53.3):** `anatoly status` sorts running runs first, highlights them in cyan, and loads reviews from the active run's directory
- **Cache layout overhaul (Epic 52):** Single `.anatoly/` root with user-wide `~/.anatoly/shared/` for cross-project cache sharing via symlinks
- **Content-addressable reviews:** Reviews, refinements, and NLP summaries are stored by content hash (SHA-256), enabling cross-project cache hits for identical file content
- **`_meta` headers:** All cached files include schema version, prompt hash, model ID, and timestamp for automatic cache invalidation when prompts change
- **`anatolyPath()` centralized path resolution:** Single entry point for all `.anatoly/` path construction, replacing scattered string literals
- **`anatoly clean shared`:** New CLI command to clear the user-wide shared cache with confirmation prompt (`--yes` for CI)
- **Legacy layout detection:** `detectLegacyLayout()` detects pre-overhaul paths and prints exact shell commands for migration
- **Isolated mode:** Replace the `shared/` symlink with a real directory to opt out of cross-project sharing
- **Integration test suite:** Cross-project mutualization, isolated mode, idempotent bootstrap, prompt invalidation, symlinks, and cache-meta overhead benchmark

### Changed

- **The lite-mode digest is removed entirely.** `buildInternalDocsDigest`, the `.anatoly/cache/internal-digest.yaml` cache, and the `ctx.internalDigest` plumbing through every axis are deleted. Lite mode never persists a doc artefact; reference content is delivered per-file (see Added). `renderReferenceDocsContext` no longer takes a digest argument.
- Pricing cache moved from `.anatoly/pricing.json` to `.anatoly/shared/pricing/normalized.json`
- Grammar WASM files moved from `.anatoly/grammars/` to `.anatoly/shared/grammars/`
- GGUF models moved from `~/.anatoly/models/` to `~/.anatoly/shared/models/gguf/`
- HuggingFace cache redirected from `~/.cache/huggingface/` to `~/.anatoly/shared/models/hf-cache/`
- Environment variable reads (`HF_HOME`, `TRANSFORMERS_CACHE`) centralized in `anatoly-paths.ts`
