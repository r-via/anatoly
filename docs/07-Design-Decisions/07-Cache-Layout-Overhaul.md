# ADR-07: Cache Layout Overhaul

**Status:** Accepted
**Date:** 2025-05-09
**Deciders:** Core team

## Context

Anatoly's original layout scattered persistent data across multiple locations:

- `<project>/.anatoly/pricing.json` (flat file, no sharding)
- `<project>/.anatoly/sources/` (raw API responses)
- `<project>/.anatoly/grammars/` (tree-sitter WASM files)
- `<project>/.anatoly/cache/refinement-cache.json` (single JSON)
- `<project>/.anatoly/correction-memory.json` (flat file)
- `~/.cache/anatoly/wasm/` (XDG-style, inconsistent with the rest)
- `~/.anatoly/models/` (GGUF files, no manifest)

This created several problems:

1. **No cross-project sharing.** Reviewing the same file in two projects produced two independent cache entries. For teams with shared libraries, this wasted significant LLM budget.
2. **No cache invalidation.** When system prompts changed, stale reviews persisted indefinitely. There was no way to know if a cached review was produced by the current or a previous prompt version.
3. **Fragile paths.** Path construction was scattered across modules using string literals, making refactoring error-prone.
4. **Inconsistent env var usage.** `HF_HOME`, `TRANSFORMERS_CACHE`, and `XDG_*` were read in multiple places with no centralization.

### Forces

- Cross-project sharing requires a single user-wide cache location
- Cache invalidation requires metadata (prompt hash, schema version) in every cached file
- Path discipline requires a single source of truth for all path construction
- Migration must be non-breaking: legacy projects must get clear instructions

## Decision

### 1. Single `.anatoly/` root with symlinks

All project data lives under `<project>/.anatoly/`. Shared caches are stored at `~/.anatoly/shared/` and accessed via symlinks from each project. This gives each project a unified view while enabling cross-project sharing.

### 2. Content-addressable shared cache

Reviews, refinements, and NLP summaries are keyed by the SHA-256 hash of the file content (not the file path). This enables:
- Cross-project cache hits for identical file content
- Rename-resilience (same content = same hash)
- Natural deduplication

### 3. `_meta` headers on all cached files

Every cached file wraps its data in a `{ _meta, data }` envelope. The `_meta` header contains:
- `schema`: format version (for future migrations)
- `prompt_hash`: SHA-256 of (schema + model + system prompt + user template)
- `model_id`: which model produced the result
- `created_at`: ISO timestamp
- `anatoly_version`: version that wrote the file

Cache loads validate `schema` and `prompt_hash` against expected values. A mismatch returns `null` (cache miss), triggering re-evaluation.

### 4. Centralized path resolution

`anatolyPath(root, area, ...rest)` is the single entry point for all path construction. The `AnatolyArea` type enumerates all valid areas. Direct path construction with string literals is banned (enforced by grep-based tests).

### 5. Isolated mode

Replacing the `shared/` symlink with a real directory opts a project out of cross-project sharing. `bootstrapAnatoly` detects this and respects the real directory.

## Consequences

### Positive

- Reviews are shared across projects with identical file content, reducing LLM costs
- Prompt changes automatically invalidate stale caches
- A single module (`anatoly-paths.ts`) controls all path resolution
- Migration is automated: `detectLegacyLayout()` prints exact shell commands
- `clean shared` CLI command enables easy cache reset

### Negative

- Symlinks add complexity on Windows (fallback to local directory)
- Content-addressable storage means the cache key is independent of file path, which can be confusing when debugging

### Neutral

- The `_meta` envelope adds ~200 bytes per cached file (negligible)
- `loadCacheWithMeta` overhead is < 20% vs raw `JSON.parse` (measured by benchmark)

## Related

- [Cache Layout](../02-Architecture/09-Cache-Layout.md)
- Epic 52: Cache Layout Overhaul (8 stories)
