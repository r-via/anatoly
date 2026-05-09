# Cache Layout

Anatoly organizes all persistent data under a single `.anatoly/` root per project, with a user-wide `~/.anatoly/` directory for cross-project shared caches.

## Directory Structure

```
<project>/.anatoly/
  shared/  -> ~/.anatoly/shared/   (symlink, or real dir in isolated mode)
  user/    -> ~/.anatoly/user/     (symlink)
  state/                           (project-only: deliberation-memory, calibration)
  cache/                           (project-only: progress, RAG index, doc-build)
    rag/
      lancedb/
    doc-build/
  runs/                            (project-only: run dirs, latest pointer)
    <runId>/
      logs/
      reviews/
      conversations/
    latest -> <runId>/
  runtime/                         (project-only: lock files, PID)
  setup/                           (project-only: setup wizard state)

~/.anatoly/
  shared/
    reviews/                       (content-addressable, sharded by 2-hex prefix)
      <aa>/<sha256-of-content>.rev.json
    refinements/
    nlp-summaries/
    pricing/
      sources/
      normalized.json
    grammars/
    models/
      gguf/
      hf-cache/
  user/
    prefs.json
```

## Design Principles

### Content-Addressable Shared Cache

Reviews, refinements, and NLP summaries are stored by their **content hash** (SHA-256 of the file body). This means:

- Two projects reviewing the same file content share the same cache entry
- Renaming a file doesn't bust the cache (same content = same hash)
- Moving code between projects preserves cache hits

Each cached file includes a `_meta` header with `schema`, `prompt_hash`, `model_id`, and `created_at`. The `prompt_hash` ensures that cache entries are invalidated when system prompts change.

### Sharding

The `reviews/` directory uses 2-character hex prefix sharding (`00/` through `ff/`), distributing files across 256 subdirectories to avoid filesystem performance degradation with large caches.

### Symlinks and Isolated Mode

By default, `bootstrapAnatoly(root)` creates symlinks:
- `<project>/.anatoly/shared/` -> `~/.anatoly/shared/`
- `<project>/.anatoly/user/` -> `~/.anatoly/user/`

This enables cross-project sharing. To disable sharing for a specific project (isolated mode), replace the symlink with a real directory:

```bash
rm <project>/.anatoly/shared
mkdir <project>/.anatoly/shared
anatoly run  # bootstrap detects the real dir and respects it
```

On the next `bootstrapAnatoly` call, the real directory is detected and preserved. A log message confirms: `"shared/ is a real directory (isolated mode)"`.

### Windows Support

On Windows without Developer Mode, symlink creation fails with `EPERM`. The bootstrap falls back to creating a real local directory with a warning. Cross-project sharing is disabled in this scenario.

## Bootstrap

`bootstrapAnatoly(root)` is called at CLI startup. It is fully idempotent:

1. Creates `<root>/.anatoly/` (mode 0700)
2. Creates `~/.anatoly/{shared,user}/` with all shared subdirectories
3. Creates symlinks (or respects existing real directories)
4. Creates project-only subdirectories (state, cache, runs, runtime, setup)
5. Sets `HF_HOME` and `TRANSFORMERS_CACHE` env vars for the HuggingFace SDK

## Migration from Legacy Layout

Projects created before Epic 52 may have files at legacy locations. Run `anatoly run` and the CLI will detect legacy paths and print migration commands:

```bash
# Required: remove obsolete cache files
rm -rf <root>/.anatoly/cache <root>/.anatoly/sources <root>/.anatoly/grammars
rm -f <root>/.anatoly/pricing.json <root>/.anatoly/correction-memory.json
rm -rf ~/.cache/anatoly/wasm

# Optional: preserve big artifacts (saves re-download)
mkdir -p ~/.anatoly/shared/models/{gguf,hf-cache}
mv ~/.anatoly/models/*.gguf ~/.anatoly/shared/models/gguf/ 2>/dev/null || true
```

## Clearing the Shared Cache

To clear all shared caches across all projects:

```bash
npx anatoly clean shared       # interactive confirmation
npx anatoly clean shared --yes # skip confirmation (CI)
```

This empties `~/.anatoly/shared/{reviews,refinements,nlp-summaries,pricing,grammars,models}/` but preserves the directory structure and does not touch `~/.anatoly/user/`.

## Path Resolution

All paths are resolved through `anatolyPath(root, area, ...rest)` in `src/utils/anatoly-paths.ts`. The `AnatolyArea` type enumerates all valid areas. Direct path construction with string literals is discouraged.

## Related

- [ADR-07: Cache Layout Overhaul](../07-Design-Decisions/07-Cache-Layout-Overhaul.md)
- [Data Flow](03-Data-Flow.md)
