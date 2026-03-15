# Claude Code Hooks

Anatoly integrates directly with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via its hooks system, creating a real-time **write -> audit -> fix** automation loop. Every time Claude Code edits a file, Anatoly reviews it in the background. When Claude Code finishes its task, Anatoly intercepts the stop signal, collects findings, and injects them back as feedback -- forcing Claude Code to fix the issues before completing.

## Table of Contents

- [Overview](#overview)
- [Initialization](#initialization)
- [How It Works](#how-it-works)
  - [PostToolUse Hook (post-edit)](#posttooluse-hook-post-edit)
  - [Stop Hook](#stop-hook)
- [Hook State](#hook-state)
- [Anti-Loop Protection](#anti-loop-protection)
- [Configuration](#configuration)
- [Disabling Hooks](#disabling-hooks)

---

## Overview

The integration uses two Claude Code hook types:

| Hook | Trigger | Anatoly Command | Behavior |
|------|---------|-----------------|----------|
| **PostToolUse** | After each `Edit` or `Write` tool call | `anatoly hook post-edit` | Spawns a background review for the edited file |
| **Stop** | When Claude Code is about to finish | `anatoly hook stop` | Waits for pending reviews, blocks with findings if issues are detected |

The result is a closed-loop workflow: Claude writes code, Anatoly audits it silently in the background, and any findings are fed back as actionable instructions before Claude finishes.

## Initialization

Run the init command to generate the hooks configuration:

```bash
npx anatoly hook init
```

This creates or updates `.claude/settings.json` with the required hooks:

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

If `.claude/settings.json` already contains a `hooks` key, the init command prints the configuration to stdout instead of overwriting, so you can merge it manually.

## How It Works

### PostToolUse Hook (post-edit)

Triggered after every `Edit` or `Write` tool call. The hook runs asynchronously so it does not block Claude Code.

**Flow:**

1. Reads the JSON payload from stdin. Claude Code provides `{ tool_name, tool_input: { file_path, ... } }`.
2. Extracts `file_path` from `tool_input` (or top-level).
3. Applies filters -- exits silently if:
   - No `file_path` in the payload.
   - The file is not a TypeScript file (`.ts`, `.tsx`, `.mts`, `.cts`).
   - The file no longer exists on disk (deleted).
   - An `anatoly run` is already active (lock file held).
   - The file's SHA-256 hash matches the existing cached review (no changes since last review).
4. Checks for an already-running review for the same file (debounce). If one exists, sends `SIGTERM` to the previous process.
5. Spawns a **detached** child process: `anatoly review --file <path> --no-cache`.
6. Records the PID and status in hook state, then exits immediately.

The review runs entirely in the background. Claude Code is not blocked at any point.

### Stop Hook

Triggered when Claude Code is about to finish its task. This hook is **synchronous** -- it blocks Claude Code until it completes (up to the 180-second timeout).

**Flow:**

1. Reads stdin JSON and checks for `stop_hook_active` (anti-loop flag -- see below).
2. Loads hook state and checks `stop_count` against `max_stop_iterations`.
3. Waits for all running reviews to complete (polls every 500ms, 120-second global timeout from `startTime` across all pending reviews).
4. Reads completed `.rev.json` files and filters symbols by `min_confidence`.
5. Collects findings where any symbol has:
   - `correction` other than `OK`
   - `utility` of `DEAD`
   - `duplication` of `DUPLICATE`
   - `overengineering` of `OVER`
6. If findings exist, outputs a JSON response using the Stop hook protocol:

```json
{
  "decision": "block",
  "reason": "Anatoly Review Findings:\n..."
}
```

The `"block"` decision prevents Claude Code from stopping and injects the `reason` as context, prompting Claude to fix the reported issues.

If no findings are detected, the hook exits with code 0 and Claude Code finishes normally.

## Hook State

Hook state is persisted to `.anatoly/hook-state.json` and tracks all in-flight reviews across a session.

```typescript
interface HookState {
  session_id: string;                    // Unique ID per session
  reviews: Record<string, HookReview>;   // Keyed by relative file path
  stop_count: number;                    // Number of times the Stop hook has fired
}

interface HookReview {
  pid: number;                           // OS process ID of the review
  status: 'running' | 'done' | 'error' | 'timeout';
  started_at: string;                    // ISO 8601 timestamp
  rev_path: string;                      // Path to the .rev.json output
}
```

**Key behaviors:**

- **Orphan detection**: On load, any review marked `running` whose PID is no longer alive is reclassified as `error`.
- **Atomic writes**: State is written atomically via a temp-file-and-rename pattern to prevent corruption from concurrent access.
- **Fresh state on corruption**: If the state file is missing or unparseable, a fresh state is initialized automatically.
- **Session scoping**: Each state has a `session_id` generated from `Date.now()` plus a random suffix.

## Anti-Loop Protection

Without safeguards, the hook loop could run indefinitely: Claude fixes issues, the Stop hook fires again with new findings, and so on. Anatoly uses two layers of protection:

1. **`stop_count` / `max_stop_iterations`**: The hook state tracks how many times the Stop hook has fired. Once `stop_count` reaches `max_stop_iterations` (default: 3, configurable 1--10), the Stop hook exits silently and allows Claude Code to finish.

2. **`stop_hook_active` flag**: Claude Code sets `stop_hook_active: true` in the stdin payload when re-entering the Stop hook after a block. If detected, Anatoly exits immediately to avoid double-processing.

## Configuration

The following `.anatoly.yml` settings affect hook behavior:

```yaml
llm:
  min_confidence: 70        # Only report findings with confidence >= this value (0-100)
  max_stop_iterations: 3    # Maximum Stop hook cycles before allowing Claude to finish (1-10)
```

| Setting | Default | Description |
|---------|---------|-------------|
| `llm.min_confidence` | `70` | Minimum confidence threshold for reporting a finding |
| `llm.max_stop_iterations` | `3` | Maximum number of write-audit-fix cycles |

## Disabling Hooks

To disable the integration, remove the `hooks` section from `.claude/settings.json`. No changes to Anatoly configuration are needed -- the hooks are entirely opt-in through the Claude Code settings file.
