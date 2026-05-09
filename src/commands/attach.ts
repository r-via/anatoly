// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `anatoly attach [runId]` — Story 53.4
 *
 * Attaches a read-only viewer to a running audit.
 * This story implements run resolution and header display.
 * Tail/TUI rendering is deferred to Story 53.5.
 * Termination handling is deferred to Story 53.6.
 */

import type { Command } from 'commander';
import { join } from 'node:path';
import chalk from 'chalk';
import { listRunStatuses, readRunStatus, isProcessAlive, writeRunStatus, type RunStatus } from '../core/run-status.js';
import { resolveRunDir } from '../utils/run-id.js';

/* ------------------------------------------------------------------ */
/*  Pure helpers — exported for testing                                */
/* ------------------------------------------------------------------ */

export type ResolveResult =
  | { ok: true; runId: string; runDir: string; status: RunStatus }
  | { ok: false; message: string; exitCode: number };

/**
 * Resolve which run to attach to.
 *
 * - Without runId: auto-selects the only active (running + alive PID) run.
 * - With runId: validates the run exists and is active.
 * - Detects crashed runs (running but PID dead) and marks them as crashed.
 */
export function resolveAttachTarget(projectRoot: string, runId?: string): ResolveResult {
  if (runId) {
    return resolveExplicitRun(projectRoot, runId);
  }
  return resolveAutoRun(projectRoot);
}

function resolveExplicitRun(projectRoot: string, runId: string): ResolveResult {
  const runDir = resolveRunDir(projectRoot, runId);
  if (!runDir) {
    return { ok: false, message: `Run "${runId}" not found.`, exitCode: 1 };
  }

  const status = readRunStatus(runDir);
  if (!status) {
    return {
      ok: false,
      message: `Run "${runId}" is not active (status: unknown). Use 'anatoly status ${runId}' for details.`,
      exitCode: 1,
    };
  }

  if (status.status !== 'running') {
    return {
      ok: false,
      message: `Run "${runId}" is not active (status: ${status.status}). Use 'anatoly status ${runId}' for details.`,
      exitCode: 1,
    };
  }

  // Check if PID is actually alive
  if (!isProcessAlive(status.pid)) {
    status.status = 'crashed';
    status.completedAt = new Date().toISOString();
    writeRunStatus(runDir, status);
    return {
      ok: false,
      message: `Run "${runId}" was running but PID ${status.pid} is dead — marked as crashed.`,
      exitCode: 2,
    };
  }

  return { ok: true, runId: status.runId, runDir, status };
}

function resolveAutoRun(projectRoot: string): ResolveResult {
  const allStatuses = listRunStatuses(projectRoot);
  const activeRuns = allStatuses.filter((s) => s.status === 'running' && isProcessAlive(s.pid));

  if (activeRuns.length === 0) {
    return {
      ok: false,
      message: "No active run found. Use 'anatoly status' to list all runs.",
      exitCode: 1,
    };
  }

  if (activeRuns.length > 1) {
    const runList = activeRuns.map((s) => `  - ${s.runId}`).join('\n');
    return {
      ok: false,
      message: `Multiple active runs:\n${runList}\nSpecify a run ID with: anatoly attach <runId>`,
      exitCode: 1,
    };
  }

  const selected = activeRuns[0];
  const runDir = resolveRunDir(projectRoot, selected.runId);
  if (!runDir) {
    return { ok: false, message: `Run directory for "${selected.runId}" not found.`, exitCode: 1 };
  }

  return { ok: true, runId: selected.runId, runDir, status: selected };
}

/**
 * Build the initial attach header shown when connecting to a run.
 * Returns plain text (no chalk) for testability.
 */
export function buildAttachHeader(status: RunStatus, logPath: string): string {
  const lines: string[] = [];
  lines.push(`  run         ${status.runId}`);
  lines.push(`  pid         ${status.pid}`);
  lines.push(`  started     ${status.startedAt}`);
  lines.push(`  branch      ${status.branch ?? '—'}`);
  lines.push(`  commit      ${status.commit ?? '—'}`);
  lines.push(`  background  ${status.background}`);
  lines.push(`  log         ${logPath}`);
  lines.push(`  attached at ${new Date().toISOString()}`);
  lines.push('');
  lines.push('  (Press Ctrl-C to detach — does not stop the run)');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  CLI registration                                                  */
/* ------------------------------------------------------------------ */

/** Registers the `attach` CLI sub-command on the given Commander program. */
export function registerAttachCommand(program: Command): void {
  program
    .command('attach [runId]')
    .description('Attach a live read-only viewer to a running audit')
    .option('--from-start', 'replay log from the beginning instead of tail-only')
    .option('--no-color', 'disable colors for piping')
    .action((runId?: string, opts?: { fromStart?: boolean }) => {
      const projectRoot = process.cwd();
      const result = resolveAttachTarget(projectRoot, runId);

      if (!result.ok) {
        console.error(result.message);
        process.exit(result.exitCode);
      }

      const logPath = join(result.runDir, 'anatoly.ndjson');

      // Print header
      console.log(chalk.bold('anatoly — attach'));
      console.log('');
      console.log(buildAttachHeader(result.status, logPath));

      // Tail/TUI rendering will be added in Story 53.5
      // Termination handling will be added in Story 53.6
      console.log('');
      console.log(chalk.dim('  (live tail not yet implemented — see Story 53.5)'));
    });
}
