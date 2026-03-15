# Watch Mode

Anatoly's watch mode is a long-running daemon that monitors your TypeScript files for changes and triggers incremental re-review automatically. It keeps the audit report up to date as you work, without requiring manual re-runs.

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [File Change Handling](#file-change-handling)
- [Performance Characteristics](#performance-characteristics)
- [Locking](#locking)
- [Use Cases](#use-cases)
- [Configuration](#configuration)
- [Comparison with Hooks](#comparison-with-hooks)

---

## Quick Start

```bash
npx anatoly watch
```

The process runs in the foreground. Press `Ctrl+C` to stop. On startup, it performs a full initial scan to index all matching files, then watches for incremental changes.

## How It Works

Watch mode uses [chokidar](https://github.com/paulmillr/chokidar) (v5) to monitor the filesystem. The lifecycle is:

1. **Initial scan**: On startup, `scanProject()` runs to index all files matching the configured glob patterns. This ensures the review cache and task files are populated before watching begins.

2. **File watcher**: chokidar monitors the `scan.include` globs with the `scan.exclude` patterns filtered out. It listens for `add`, `change`, and `unlink` events.

3. **Sequential processing queue**: Changed files are added to an internal queue and processed one at a time. Duplicate entries (same file queued multiple times before processing) are deduplicated.

4. **Per-file pipeline**: For each changed file:
   - Compute SHA-256 hash.
   - Parse the AST with web-tree-sitter to extract symbols.
   - Write a `.task.json` file.
   - Run the evaluator (same review pipeline as `anatoly review`).
   - Write the `.rev.json` output.
   - Regenerate the aggregate `report.md`.

5. **File deletion**: When a file is deleted (`unlink` event), its task file, review file, and progress entry are removed. The report is regenerated to reflect the deletion.

6. **Graceful shutdown**: On `SIGINT` (Ctrl+C), the watcher closes and the lock file is released.

## File Change Handling

chokidar is configured with write stabilization to avoid processing partially-written files:

```
awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
```

This means a file change event only fires after the file has been stable (no further writes) for 200ms, polled every 50ms.

**Filtering:**

- Files matching `scan.exclude` patterns are ignored by chokidar.
- Files tracked by `.gitignore` are skipped via a runtime `isGitIgnored()` check.
- Initial file events are suppressed (`ignoreInitial: true`) since the startup scan already covers existing files.

## Performance Characteristics

| Aspect | Behavior |
|--------|----------|
| **Startup** | Full project scan (AST parsing + hashing). Scales linearly with file count. |
| **Incremental** | Only the changed file is re-scanned and re-reviewed. One API call per file. |
| **Queue** | Serial processing. Multiple rapid edits to different files are queued and processed in order. |
| **Deduplication** | If the same file is modified multiple times while a review is in progress, only one re-review is queued. |
| **Report regeneration** | After each review completes, the full report is regenerated from all cached reviews. This is a local operation (no API calls). |
| **Memory** | chokidar uses efficient filesystem watchers (`inotify` on Linux, `FSEvents` on macOS). Memory overhead is minimal for typical project sizes. |
| **CPU** | Idle when no files change. Each file change triggers AST parsing (fast, <100ms for most files) plus one LLM evaluation call. |

**Typical latency**: From file save to updated review, expect 5--15 seconds depending on file complexity and API response time.

## Locking

Watch mode acquires a project lock (`acquireLock`) on startup to prevent conflicts with concurrent Anatoly instances. This means:

- Running `anatoly run` while watch mode is active will detect the lock and warn.
- The Claude Code `post-edit` hook checks `isLockActive()` and exits silently if watch mode holds the lock, avoiding duplicate reviews.
- The lock is released on graceful shutdown (`SIGINT`).

If the process is killed forcefully (e.g., `SIGKILL`), the stale lock file may need manual removal. It is located at `.anatoly/lock`.

## Use Cases

### Active Development

Run watch mode in a terminal while coding. Every save triggers a background review, so you get near-real-time feedback on code quality without switching context.

```bash
# Terminal 1: your editor
# Terminal 2:
npx anatoly watch
```

The console shows live output:

```
anatoly -- watch
  watching src/**/*.ts, src/**/*.tsx
  press Ctrl+C to stop

  initial scan 42 files (0 new, 42 cached)

  scanned src/utils/cache.ts
  reviewed src/utils/cache.ts -> PASS
  scanned src/core/scanner.ts
  reviewed src/core/scanner.ts -> NEEDS_WORK
```

### Pre-Commit Verification

Start watch mode, make your changes, then check the report before committing:

```bash
npx anatoly watch &
# ... make changes ...
# Check .anatoly/report.md
kill %1
```

### Pairing with Claude Code Hooks

Watch mode and Claude Code hooks serve similar purposes but operate differently. You typically use **one or the other**, not both. See [Comparison with Hooks](#comparison-with-hooks) below.

## Configuration

Watch mode respects the same `.anatoly.yml` configuration as all other commands:

```yaml
scan:
  include:
    - 'src/**/*.ts'
    - 'src/**/*.tsx'
  exclude:
    - 'node_modules/**'
    - 'dist/**'
    - '**/*.test.ts'
    - '**/*.spec.ts'
```

All `llm` settings (model, concurrency, min_confidence, axes, etc.) apply identically to watch mode reviews.

## Comparison with Hooks

Both watch mode and Claude Code hooks provide real-time audit feedback, but they target different workflows:

| | Watch Mode | Claude Code Hooks |
|-|------------|-------------------|
| **Trigger** | Filesystem events (any editor) | Claude Code `Edit`/`Write` tool calls |
| **Scope** | All file changes in the project | Only files edited by Claude Code |
| **Feedback** | Console output + report file | Injected directly into Claude Code as blocking feedback |
| **Autocorrection** | Manual (you read the report and fix) | Automatic (Claude Code fixes issues in-loop) |
| **Best for** | Manual development, any editor | Claude Code agentic sessions |

If you are using Claude Code and want automatic fix cycles, use the hooks (`anatoly hook init`). If you want passive monitoring during manual development, use watch mode.
