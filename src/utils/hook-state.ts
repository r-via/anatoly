import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { atomicWriteJson } from './cache.js';

export interface HookReview {
  pid: number;
  status: 'running' | 'done' | 'error' | 'timeout';
  started_at: string;
  rev_path: string;
}

export interface HookState {
  session_id: string;
  reviews: Record<string, HookReview>;
  stop_count: number;
}

function hookStatePath(projectRoot: string): string {
  return resolve(projectRoot, '.anatoly', 'hook-state.json');
}

/**
 * Generate a unique session ID for the hook state.
 */
function generateSessionId(): string {
  return `hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a fresh hook state.
 */
export function initHookState(): HookState {
  return {
    session_id: generateSessionId(),
    reviews: {},
    stop_count: 0,
  };
}

/**
 * Load hook state from disk.
 * Returns fresh state if file doesn't exist or is corrupted.
 * Detects orphaned state from a previous session and resets it.
 */
export function loadHookState(projectRoot: string): HookState {
  const path = hookStatePath(projectRoot);
  if (!existsSync(path)) return initHookState();

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as HookState;

    // Validate structure
    if (!raw.session_id || typeof raw.reviews !== 'object') {
      return initHookState();
    }

    // Ensure stop_count exists (backward compat with old state files)
    if (typeof raw.stop_count !== 'number') {
      raw.stop_count = 0;
    }

    // Clean up reviews with dead PIDs (orphaned from crash)
    for (const [file, review] of Object.entries(raw.reviews)) {
      if (review.status === 'running' && !isProcessRunning(review.pid)) {
        raw.reviews[file] = { ...review, status: 'error' };
      }
    }

    return raw;
  } catch {
    return initHookState();
  }
}

/**
 * Save hook state to disk atomically.
 */
export function saveHookState(projectRoot: string, state: HookState): void {
  const path = hookStatePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, state);
}

/**
 * Check if a process with the given PID is still running.
 */
export function isProcessRunning(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
