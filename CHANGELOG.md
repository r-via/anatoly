# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Lite-mode digest now consolidates reference doc CONTENT (not just paths):** The lite digest (`.anatoly/cache/internal-digest.yaml`) used to list reference doc paths as a table of contents. It now embeds the verbatim Markdown body of `documentation.reference.paths` (README, specs, `docs/*.md`), so the `correction`, `best-practices`, and `overengineering` axes finally receive authoritative doc context in lite mode.
- **`documentation.internal.lite.on_overflow`:** New required field (`warn` | `fail`, default `warn`). Controls the behaviour when consolidated reference content exceeds `max_tokens`. `warn` ships a best-effort digest with an `> INCOMPLETE` marker and a logger warning listing what was dropped. `fail` throws `DigestOverflowError` so CI catches misconfigured docs.
- **Single readable YAML cache:** Digest cache is now `.anatoly/cache/internal-digest.yaml` with a literal block-scalar for `content`, so the Markdown is directly viewable in an editor. Previous JSON-with-escaped-string layout removed.
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

- **`documentation.internal.lite.max_tokens` default raised from 4000 to 12000.** Lite is positioned as the mode for repos whose reference docs fit verbatim; 4000 was too tight for most projects with a meaningful README. Existing YAMLs that pin `max_tokens: 4000` are unaffected.
- **Lite digest no longer emits `## Modules`.** Project structure was duplicated with `ctx.projectTree` (already injected into `best-practices`). The digest is now scoped to reference content, inline doc-comments, and public surface only.
- **Lite digest fingerprint now hashes reference doc CONTENT (not just paths).** Editing a README correctly invalidates the cache on the next run.
- Pricing cache moved from `.anatoly/pricing.json` to `.anatoly/shared/pricing/normalized.json`
- Grammar WASM files moved from `.anatoly/grammars/` to `.anatoly/shared/grammars/`
- GGUF models moved from `~/.anatoly/models/` to `~/.anatoly/shared/models/gguf/`
- HuggingFace cache redirected from `~/.cache/huggingface/` to `~/.anatoly/shared/models/hf-cache/`
- Environment variable reads (`HF_HOME`, `TRANSFORMERS_CACHE`) centralized in `anatoly-paths.ts`
