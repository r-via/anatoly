# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Cache layout overhaul (Epic 52):** Single `.anatoly/` root with user-wide `~/.anatoly/shared/` for cross-project cache sharing via symlinks
- **Content-addressable reviews:** Reviews, refinements, and NLP summaries are stored by content hash (SHA-256), enabling cross-project cache hits for identical file content
- **`_meta` headers:** All cached files include schema version, prompt hash, model ID, and timestamp for automatic cache invalidation when prompts change
- **`anatolyPath()` centralized path resolution:** Single entry point for all `.anatoly/` path construction, replacing scattered string literals
- **`anatoly clean shared`:** New CLI command to clear the user-wide shared cache with confirmation prompt (`--yes` for CI)
- **Legacy layout detection:** `detectLegacyLayout()` detects pre-overhaul paths and prints exact shell commands for migration
- **Isolated mode:** Replace the `shared/` symlink with a real directory to opt out of cross-project sharing
- **Integration test suite:** Cross-project mutualization, isolated mode, idempotent bootstrap, prompt invalidation, symlinks, and cache-meta overhead benchmark

### Changed

- Pricing cache moved from `.anatoly/pricing.json` to `.anatoly/shared/pricing/normalized.json`
- Grammar WASM files moved from `.anatoly/grammars/` to `.anatoly/shared/grammars/`
- GGUF models moved from `~/.anatoly/models/` to `~/.anatoly/shared/models/gguf/`
- HuggingFace cache redirected from `~/.cache/huggingface/` to `~/.anatoly/shared/models/hf-cache/`
- Environment variable reads (`HF_HOME`, `TRANSFORMERS_CACHE`) centralized in `anatoly-paths.ts`
