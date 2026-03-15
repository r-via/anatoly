# Claude Code Hook Integration

Anatoly integrates with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via the hooks protocol to provide real-time code review during AI-assisted development. When Claude Code edits a TypeScript file, Anatoly reviews it in the background. When Claude Code finishes its task, Anatoly injects any findings as feedback — creating an automatic write-audit-fix loop.

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Hook Registration](#hook-registration)
- [PostToolUse Hook (post-edit)](#posttooluse-hook-post-edit)
- [Stop Hook](#stop-hook)
- [Anti-Loop Protection](#anti-loop-protection)
- [Hook State](#hook-state)
- [Configuration](#configuration)
- [Disabling the Hook](#disabling-the-hook)

---

## Quick Start

```bash
npx anatoly hook init
```

This writes the hooks configuration to `.claude/settings.json`. Once registered, the hooks activate automatically in your next Claude Code session.

---

## How It Works

```
Claude Code edits a .ts file
  ↓
PostToolUse hook fires (async)
  ↓
Anatoly spawns background review (detached process)
  ↓
Claude Code continues working (no blocking)
  ↓
Claude Code finishes its task
  ↓
Stop hook fires (sync, up to 180s)
  ↓
Anatoly waits for pending reviews, collects findings
  ↓
Findings injected → Claude Code autocorrects
  ↓
Repeat (up to max_stop_iterations)
```

The loop repeats automatically: Claude Code fixes the findings, which triggers new PostToolUse hooks, and the next Stop hook checks the fixes. After `max_stop_iterations` (default 3), the Stop hook allows Claude Code to finish.

---

## Hook Registration

### `hook init`

```bash
npx anatoly hook init
```

**Behavior:**
- Creates `.claude/settings.json` if it doesn't exist
- Merges hooks config into existing settings if no `hooks` key exists
- Prints config to stdout for manual merge if hooks already exist (prevents overwrite)

**Generated configuration:**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx anatoly hook post-edit",
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx anatoly hook stop",
            "timeout": 180
          }
        ]
      }
    ]
  }
}
```

### Registered Hooks

| Hook | Event | Blocking | Purpose |
|------|-------|----------|---------|
| `post-edit` | After `Edit` or `Write` tool use | No (async) | Spawn background review |
| `stop` | When Claude Code is about to finish | Yes (180s timeout) | Collect findings and inject feedback |

---

## PostToolUse Hook (post-edit)

**Command:** `npx anatoly hook post-edit`

**Trigger:** Claude Code calls the `Edit` or `Write` tool (matched by `"Edit|Write"` pattern).

**Input:** Claude Code pipes a JSON payload to stdin:

```json
{
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "src/utils/format.ts",
    "old_string": "...",
    "new_string": "..."
  }
}
```

### Processing Flow

1. **Extract file path** from `tool_input.file_path` (or top-level `file_path`)
2. **Apply filters** — exit silently if any fail:

| Filter | Check | Reason |
|--------|-------|--------|
| No path | `file_path` missing from payload | Not a file edit |
| Extension | Not `.ts`, `.tsx`, `.mts`, `.cts` | Only TypeScript files |
| Exists | File doesn't exist on disk | File was deleted |
| Lock | `isLockActive()` returns true | Another `anatoly run` is active |
| Hash | SHA-256 matches cached `.task.json` hash | File unchanged since last review |

3. **Debounce** — if a review is already running for this file, send `SIGTERM` to the old process
4. **Spawn detached review:**

```typescript
const child = spawn(process.execPath,
  [process.argv[1], 'review', '--file', relPath, '--no-cache'],
  {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ANATOLY_HOOK_MODE: '1' },
  },
);
child.unref();
```

5. **Update hook state** with PID and status
6. **Exit immediately** — Claude Code continues without waiting

The review process runs in the background with `ANATOLY_HOOK_MODE=1` set in the environment.

---

## Stop Hook

**Command:** `npx anatoly hook stop`

**Trigger:** Claude Code is about to finish its current task.

**Timeout:** 180 seconds (configured in `.claude/settings.json`).

### Processing Flow

1. **Anti-loop check** — exit if `stop_hook_active` flag is set in stdin payload (prevents re-entry)
2. **Anti-loop check** — exit if `stop_count >= max_stop_iterations`
3. **Increment `stop_count`** in hook state
4. **Wait for running reviews** — poll every 500ms until all PIDs finish or 120s timeout
5. **Collect findings** from `.rev.json` files:
   - Filter symbols by `confidence >= min_confidence` (default 70)
   - Include symbols where any of:
     - `correction !== 'OK'`
     - `utility === 'DEAD'`
     - `duplication === 'DUPLICATE'`
     - `overengineering === 'OVER'`
6. **Return Claude Code Stop protocol response:**

### Response Format

If findings exist:

```json
{
  "decision": "block",
  "reason": "Anatoly Review Findings:\nThe following issues were detected by Anatoly's deep audit:\n\nsrc/foo.ts (NEEDS_REFACTOR):\n- functionName (L10–L45, confidence: 85%): correction: NEEDS_FIX, utility: DEAD\n  Symbol is declared but never used in project.\n\nPlease fix these issues before completing your task."
}
```

The `"block"` decision prevents Claude Code from stopping and injects the reason text as context, prompting autocorrection.

If no findings (or max iterations reached):

```json
{
  "decision": "pass"
}
```

The `"pass"` decision allows Claude Code to finish normally.

---

## Anti-Loop Protection

Two layers prevent infinite write-audit-fix cycles:

### Layer 1: `stop_count` / `max_stop_iterations`

Each time the Stop hook fires, `stop_count` is incremented and persisted in `hook-state.json`. When `stop_count >= max_stop_iterations` (default 3), the hook exits silently and allows Claude Code to finish.

This limits the autocorrection loop to at most 3 iterations:
1. Claude edits → Anatoly reviews → findings injected
2. Claude fixes → Anatoly re-reviews → fewer findings
3. Claude fixes remaining → Anatoly re-reviews → done (or allowed to finish)

### Layer 2: `stop_hook_active` Flag

Claude Code may set `stop_hook_active: true` in the Stop hook stdin payload on re-entry. If detected, the hook exits immediately to avoid double-processing.

### Layer 3: Hash Deduplication

The PostToolUse hook compares the file's SHA-256 hash against the cached task hash. If the file hasn't changed since its last review, the hook skips it entirely — no review is spawned.

---

## Hook State

**File:** `.anatoly/hook-state.json`

**Source:** `src/utils/hook-state.ts`

```json
{
  "session_id": "hook-1710505425000-a1b2c3",
  "reviews": {
    "src/utils/format.ts": {
      "pid": 12345,
      "status": "done",
      "started_at": "2026-03-15T14:23:45.000Z",
      "rev_path": "/abs/path/.anatoly/reviews/src-utils-format.rev.json"
    }
  },
  "stop_count": 1
}
```

### HookState Fields

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Unique session ID: `hook-<timestamp>-<random>` |
| `reviews` | Record | Map of file path → review status |
| `stop_count` | integer | Number of times Stop hook has fired this session |

### HookReview Fields

| Field | Type | Values |
|-------|------|--------|
| `pid` | number | OS process ID of the review process |
| `status` | string | `running` · `done` · `error` · `timeout` |
| `started_at` | string | ISO 8601 timestamp |
| `rev_path` | string | Absolute path to the `.rev.json` output |

### Orphan Detection

On `loadHookState()`, any review with `status: 'running'` whose PID is no longer alive is automatically reclassified to `status: 'error'`. This handles crashes and interrupted reviews.

---

## Configuration

### `.anatoly.yml` Settings

```yaml
llm:
  min_confidence: 70        # Only report findings with confidence >= this value
  max_stop_iterations: 3    # Max write-audit-fix cycles before allowing stop
```

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `llm.min_confidence` | integer | 70 | 0–100 | Confidence threshold for hook findings |
| `llm.max_stop_iterations` | integer | 3 | 1–10 | Anti-loop limit for Stop hook |

### Environment Variables

| Variable | Set By | Purpose |
|----------|--------|---------|
| `ANATOLY_HOOK_MODE` | PostToolUse hook | Signals to the review command that it's running in hook mode |

---

## Disabling the Hook

Remove the `hooks` section from `.claude/settings.json`, or delete the file entirely:

```bash
rm .claude/settings.json
```

The hook has no effect when not registered in Claude Code settings.

---

## CLI Commands

All three subcommands are registered under `anatoly hook`:

```bash
npx anatoly hook init        # Generate .claude/settings.json
npx anatoly hook post-edit   # Internal: PostToolUse handler
npx anatoly hook stop        # Internal: Stop handler
```

The `post-edit` and `stop` subcommands are designed for Claude Code hooks, not direct user invocation. Only `hook init` is user-facing.

---

See also: [Configuration](configuration.md) · [Runtime Directory](runtime-directory.md) · [How It Works](how-it-works.md)
