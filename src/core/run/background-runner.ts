// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Background Runner — Story 47.3
 *
 * Spawns a detached child process to run the audit pipeline in the background.
 * The parent process returns immediately with the runId, and the child runs
 * the full pipeline against a git worktree snapshot.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeRunStatus, getGitInfo, type RunStatus } from './run-status.js';

export interface BackgroundLaunchResult {
  runId: string;
  pid: number;
}

/**
 * Launch a background audit run.
 *
 * 1. Writes initial run-status.json with status=running
 * 2. Spawns a detached child process running `anatoly run --run-id <runId> [forwardedArgs]`
 * 3. Returns immediately with the runId and child PID
 *
 * The child process inherits the current environment (API keys, etc.)
 * and runs against the main project root (worktree creation happens inside the child).
 */
export function launchBackgroundRun(
  projectRoot: string,
  runId: string,
  runDir: string,
  forwardedArgs: string[],
): BackgroundLaunchResult {
  const gitInfo = getGitInfo(projectRoot);

  // Write initial status before spawning (ensures status file exists even if spawn fails)
  const status: RunStatus = {
    runId,
    pid: 0, // Updated after spawn
    status: 'running',
    startedAt: new Date().toISOString(),
    branch: gitInfo.branch,
    commit: gitInfo.commit,
    background: true,
  };
  writeRunStatus(runDir, status);

  // Build child process args — re-invoke anatoly run without --background
  // The child inherits the same Node.js binary and entry point
  const childArgs = [
    process.argv[1], // Path to anatoly CLI entry point
    'run',
    '--run-id', runId,
    ...forwardedArgs,
  ];

  // Redirect child stdout/stderr to background.log in the run directory
  mkdirSync(runDir, { recursive: true });
  const logPath = join(runDir, 'background.log');
  const logStream = createWriteStream(logPath, { flags: 'a' });

  const child = spawn(process.execPath, childArgs, {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: {
      ...process.env,
      ANATOLY_BACKGROUND_MODE: '1',
    },
  });

  // Allow parent to exit independently
  child.unref();

  // Update status with actual PID
  status.pid = child.pid ?? 0;
  writeRunStatus(runDir, status);

  // Handle spawn errors — mark as failed if child exits immediately
  child.on('error', (err) => {
    const failedStatus: RunStatus = {
      ...status,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: err.message,
    };
    writeRunStatus(runDir, failedStatus);
    writeFileSync(join(runDir, 'error.log'), `Spawn error: ${err.message}\n`);
  });

  return { runId, pid: status.pid };
}

/**
 * Build the list of CLI arguments to forward from parent to child,
 * excluding --background and --run-id (which we set explicitly).
 */
export function buildForwardedArgs(cmdOpts: Record<string, unknown>): string[] {
  const args: string[] = [];

  if (cmdOpts.axes) args.push('--axes', String(cmdOpts.axes));
  if (cmdOpts.cache === false) args.push('--no-cache');
  if (cmdOpts.file) args.push('--file', String(cmdOpts.file));
  if (cmdOpts.concurrency) args.push('--concurrency', String(cmdOpts.concurrency));
  if (cmdOpts.sdkConcurrency) args.push('--sdk-concurrency', String(cmdOpts.sdkConcurrency));
  if (cmdOpts.rebuildRag) args.push('--rebuild-rag');
  if (cmdOpts.codeModel) args.push('--code-model', String(cmdOpts.codeModel));
  if (cmdOpts.nlpModel) args.push('--nlp-model', String(cmdOpts.nlpModel));
  if (cmdOpts.triage === false) args.push('--no-triage');
  if (cmdOpts.deliberation === true) args.push('--deliberation');
  if (cmdOpts.deliberation === false) args.push('--no-deliberation');
  if (cmdOpts.badge === false) args.push('--no-badge');
  if (cmdOpts.badgeVerdict) args.push('--badge-verdict');
  if (cmdOpts.flushMemory) args.push('--flush-memory');
  if (cmdOpts.notify === false) args.push('--no-notify');

  return args;
}
