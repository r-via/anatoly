// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { resolve, relative, extname } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { loadConfig } from '../utils/config-loader.js';
import { computeFileHash, toOutputName } from '../utils/cache.js';
import { isLockActive } from '../utils/lock.js';
import type { ReviewFile } from '../schemas/review.js';
import { loadHookState, saveHookState, isProcessRunning } from '../utils/hook-state.js';
import { getLogger } from '../utils/logger.js';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * Read all of stdin as a string (for hook JSON payloads).
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Extract file_path from Claude Code hook stdin JSON.
 *
 * PostToolUse hooks receive: `{ tool_name, tool_input: { file_path, ... }, ... }`.
 * Checks `tool_input.file_path` first, then falls back to a top-level `file_path` field.
 *
 * @param stdinJson - Raw JSON string read from stdin.
 * @returns The extracted file path, or `null` if the JSON is malformed or contains no file_path.
 */
function extractFilePath(stdinJson: string): string | null {
  try {
    const payload = JSON.parse(stdinJson) as Record<string, unknown>;
    const toolInput = payload.tool_input as Record<string, unknown> | undefined;
    if (toolInput && typeof toolInput.file_path === 'string') {
      return toolInput.file_path;
    }
    // Also check top-level file_path
    if (typeof payload.file_path === 'string') {
      return payload.file_path;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Registers the `hook` CLI sub-command on the given Commander program.
 *
 * Adds three subcommands for Claude Code hook integration:
 *
 * - **`on-edit`** — PostToolUse hook triggered after Edit/Write. Reads the edited file path
 *   from stdin JSON, debounces by killing any already-running review for the same file, then
 *   spawns a detached `anatoly review` child process in the background. Skips non-TypeScript
 *   files, deleted files, unchanged files (by SHA-256 hash), and files reviewed while an
 *   `anatoly run` lock is active.
 *
 * - **`on-stop`** — Stop hook triggered when Claude Code finishes a task. Waits (up to 120 s)
 *   for all running background reviews to complete, collects significant findings filtered by
 *   `min_confidence`, and emits a `{ decision: "block", reason }` JSON payload to stdout to
 *   prevent Claude Code from stopping and inject findings for autocorrection. Includes anti-loop
 *   protection via `stop_count` checked against `max_stop_iterations`.
 *
 * - **`init`** — Generates or merges Claude Code hooks configuration into `.claude/settings.json`.
 *
 * @param program - The root Commander instance.
 */
export function registerHookCommand(program: Command): void {
  const hookCmd = program
    .command('hook')
    .description('Claude Code integration hooks (internal)')
    .addHelpText('after', '\nThese subcommands are designed for Claude Code hooks, not direct user invocation.');

  // --- hook on-edit ---
  hookCmd
    .command('on-edit')
    .description('PostToolUse hook: queue background review for edited file')
    .action(async () => {
      const projectRoot = resolve('.');

      // Read stdin JSON from Claude Code
      const stdinData = await readStdin();
      const filePath = extractFilePath(stdinData);

      if (!filePath) {
        // No file_path in payload — exit silently
        process.exit(0);
      }

      // Resolve to relative path
      const absPath = resolve(projectRoot, filePath);
      const relPath = relative(projectRoot, absPath);

      // Skip non-TS files
      const ext = extname(relPath);
      if (!TS_EXTENSIONS.has(ext)) {
        process.exit(0);
      }

      // Skip if file doesn't exist (deleted)
      if (!existsSync(absPath)) {
        process.exit(0);
      }

      // Skip if anatoly run is active (lock held by another process)
      if (isLockActive(projectRoot)) {
        process.exit(0);
      }

      // Check SHA-256 hash — skip if unchanged from cached review
      const currentHash = computeFileHash(absPath);
      const outputName = toOutputName(relPath);
      const revJsonPath = resolve(projectRoot, '.anatoly', 'reviews', `${outputName}.rev.json`);
      if (existsSync(revJsonPath)) {
        try {
          const existingReview = JSON.parse(readFileSync(revJsonPath, 'utf-8')) as ReviewFile;
          // If the review's file matches and we have a matching task hash, skip
          const taskPath = resolve(projectRoot, '.anatoly', 'tasks', `${outputName}.task.json`);
          if (existsSync(taskPath)) {
            const task = JSON.parse(readFileSync(taskPath, 'utf-8')) as { hash: string };
            if (task.hash === currentHash && existingReview.file === relPath) {
              process.exit(0);
            }
          }
        } catch {
          // Corrupted review/task — proceed with re-review
        }
      }

      // Load or initialize hook state
      const state = loadHookState(projectRoot);

      // Debounce: if a review for this file is already running, kill it
      const existingReview = state.reviews[relPath];
      if (existingReview && existingReview.status === 'running' && existingReview.pid) {
        try {
          process.kill(existingReview.pid, 'SIGTERM');
        } catch {
          // Process may have already exited
        }
      }

      // Spawn detached child process: anatoly review --file <path> --no-cache
      const child = spawn(
        process.execPath,
        [process.argv[1], 'review', '--file', relPath, '--no-cache'],
        {
          cwd: projectRoot,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ANATOLY_HOOK_MODE: '1' },
        },
      );
      child.unref();

      // Update hook state — if spawn failed (pid undefined), mark as error immediately
      if (!child.pid) {
        state.reviews[relPath] = {
          pid: 0,
          status: 'error',
          started_at: new Date().toISOString(),
          rev_path: revJsonPath,
        };
        saveHookState(projectRoot, state);
        process.exit(0);
      }

      state.reviews[relPath] = {
        pid: child.pid,
        status: 'running',
        started_at: new Date().toISOString(),
        rev_path: revJsonPath,
      };
      saveHookState(projectRoot, state);

      // Exit immediately — review continues in background
      process.exit(0);
    });

  // --- hook on-stop ---
  hookCmd
    .command('on-stop')
    .description('Stop hook: wait for reviews, inject findings as feedback')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);
      const minConfidence = config.llm.min_confidence;

      // Read stdin JSON from Claude Code to check stop_hook_active
      const stdinData = await readStdin();
      let stopHookActive = false;
      try {
        const payload = JSON.parse(stdinData) as Record<string, unknown>;
        stopHookActive = payload.stop_hook_active === true;
      } catch {
        // No valid JSON — proceed normally
      }

      // Anti-loop protection: if Claude Code signals this is a re-entry, skip
      if (stopHookActive) {
        process.exit(0);
      }

      const state = loadHookState(projectRoot);
      const maxStopIterations = config.llm.max_stop_iterations;

      // Anti-loop: check stop_count against max_stop_iterations
      if (state.stop_count >= maxStopIterations) {
        getLogger().warn({ stopCount: state.stop_count, maxStopIterations }, 'hook on-stop: max iterations reached, exiting silently');
        process.exit(0);
      }

      // stop_count is incremented below only when a block decision is emitted

      // Wait for running reviews to complete (timeout 120s)
      const timeoutMs = 120_000;
      const startTime = Date.now();
      const runningFiles = Object.entries(state.reviews).filter(
        ([, r]) => r.status === 'running',
      );

      for (const [file, review] of runningFiles) {
        // Skip reviews with invalid pid (spawn failed)
        if (review.pid === 0) {
          state.reviews[file] = { ...review, status: 'timeout' };
          continue;
        }

        const elapsed = Date.now() - startTime;
        const remaining = timeoutMs - elapsed;

        if (remaining <= 0) {
          getLogger().warn({ file }, 'hook on-stop: timeout waiting for review');
          state.reviews[file] = { ...review, status: 'timeout' };
          continue;
        }

        // Poll until process finishes or timeout
        await waitForProcess(review.pid, remaining);

        // Check if process is still running
        if (isProcessRunning(review.pid)) {
          getLogger().warn({ file }, 'hook on-stop: review still running after timeout');
          state.reviews[file] = { ...review, status: 'timeout' };
        } else {
          state.reviews[file] = { ...review, status: 'done' };
        }
      }

      // Collect findings from completed reviews
      const findings: Array<{ file: string; symbols: ReviewFile['symbols']; verdict: string }> = [];

      for (const [file, review] of Object.entries(state.reviews)) {
        if (review.status !== 'done' && review.status !== 'running') continue;

        // Check if process has actually finished
        if (review.pid && isProcessRunning(review.pid)) continue;

        const revPath = review.rev_path;
        if (!revPath || !existsSync(revPath)) continue;

        try {
          const revData = JSON.parse(readFileSync(revPath, 'utf-8')) as ReviewFile;

          // Filter symbols by min_confidence
          const significantSymbols = revData.symbols.filter(
            (s) => s.confidence >= minConfidence &&
              (s.correction !== 'OK' || s.utility === 'DEAD' || s.duplication === 'DUPLICATE' || s.overengineering === 'OVER'),
          );

          if (significantSymbols.length > 0) {
            findings.push({
              file: revData.file,
              symbols: significantSymbols,
              verdict: revData.verdict,
            });
          }
        } catch {
          // Corrupted or incomplete review — skip
        }
      }

      // If no findings, save state and exit cleanly (no stop_count increment)
      if (findings.length === 0) {
        saveHookState(projectRoot, state);
        process.exit(0);
      }

      // Block decision: increment stop_count before saving
      state.stop_count++;
      saveHookState(projectRoot, state);

      // Format findings as reason for Claude Code Stop hook protocol
      const contextLines: string[] = [];
      contextLines.push('Anatoly Review Findings:');
      contextLines.push('The following issues were detected by Anatoly\'s deep audit:');
      contextLines.push('');

      for (const finding of findings) {
        contextLines.push(`${finding.file} (${finding.verdict}):`);
        for (const s of finding.symbols) {
          const issues: string[] = [];
          if (s.correction !== 'OK') issues.push(`correction: ${s.correction}`);
          if (s.utility === 'DEAD') issues.push('utility: DEAD');
          if (s.utility === 'LOW_VALUE') issues.push('utility: LOW_VALUE');
          if (s.duplication === 'DUPLICATE') issues.push(`duplication: DUPLICATE${s.duplicate_target ? ` (${s.duplicate_target.file}:${s.duplicate_target.symbol})` : ''}`);
          if (s.overengineering === 'OVER') issues.push('overengineering: OVER');

          contextLines.push(`- ${s.name} (L${s.line_start}–L${s.line_end}, confidence: ${s.confidence}%): ${issues.join(', ')}`);
          contextLines.push(`  ${s.detail}`);
        }
        contextLines.push('');
      }

      contextLines.push('Please fix these issues before completing your task.');

      // Output as JSON for Claude Code Stop hook protocol
      // Use decision: "block" + reason to prevent Claude from stopping and inject findings
      const output = JSON.stringify({
        decision: 'block',
        reason: contextLines.join('\n'),
      });
      process.stdout.write(output);
      process.exit(0);
    });

  // --- hook init ---
  hookCmd
    .command('init')
    .description('Generate Claude Code hooks configuration for autocorrection loop')
    .action(() => {
      const projectRoot = resolve('.');
      const settingsDir = resolve(projectRoot, '.claude');
      const settingsPath = resolve(settingsDir, 'settings.json');

      const hooksConfig = {
        hooks: {
          PostToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [
                {
                  type: 'command',
                  command: 'npx anatoly hook on-edit',
                  async: true,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'npx anatoly hook on-stop',
                  timeout: 180,
                },
              ],
            },
          ],
        },
      };

      // Check if settings.json already exists
      if (existsSync(settingsPath)) {
        try {
          const existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
          if (existing.hooks) {
            console.log(`${chalk.yellow('warning')}: .claude/settings.json already has hooks configured.`);
            console.log('  To avoid overwriting, merge manually:');
            console.log('');
            console.log(JSON.stringify(hooksConfig, null, 2));
            return;
          }

          // Merge hooks into existing settings
          const merged = { ...existing, ...hooksConfig };
          mkdirSync(settingsDir, { recursive: true });
          writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
          console.log(`${chalk.green('done')}: hooks added to .claude/settings.json`);
        } catch {
          // Corrupted settings — write fresh
          mkdirSync(settingsDir, { recursive: true });
          writeFileSync(settingsPath, JSON.stringify(hooksConfig, null, 2) + '\n');
          console.log(`${chalk.green('done')}: .claude/settings.json created`);
        }
      } else {
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(hooksConfig, null, 2) + '\n');
        console.log(`${chalk.green('done')}: .claude/settings.json created`);
      }

      console.log('');
      console.log('Claude Code Integration');
      console.log('');
      console.log('  How it works:');
      console.log('  1. PostToolUse hook triggers after each Edit/Write');
      console.log('     Launches background review for the edited file');
      console.log('  2. Stop hook triggers when Claude Code finishes its task');
      console.log('     Collects findings and injects them for autocorrection');
      console.log('');
      console.log('  Configuration (.anatoly.yml):');
      console.log('    llm:');
      console.log('      min_confidence: 70   # Only report findings >= this confidence');
      console.log('');
      console.log('  Disable: remove the hooks section from .claude/settings.json');
    });
}

/**
 * Wait for a process to exit, polling every 500 ms.
 *
 * Returns silently when the process exits or when the timeout is reached — callers
 * should check {@link isProcessRunning} afterward to distinguish the two outcomes.
 *
 * @param pid - OS process ID to monitor.
 * @param timeoutMs - Maximum time in milliseconds to wait before returning.
 */
async function waitForProcess(pid: number, timeoutMs: number): Promise<void> {
  const pollInterval = 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}
