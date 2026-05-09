// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `anatoly attach [runId]` — Stories 53.4 + 53.5
 *
 * Attaches a read-only viewer to a running audit.
 * Story 53.4: run resolution and header display.
 * Story 53.5: ndjson tail + TUI live rendering + --from-start.
 * Termination handling is deferred to Story 53.6.
 */

import type { Command } from 'commander';
import { join } from 'node:path';
import chalk from 'chalk';
import { listRunStatuses, readRunStatus, isProcessAlive, writeRunStatus, type RunStatus } from '../core/run-status.js';
import { resolveRunDir } from '../utils/run-id.js';
import { tailNdjson, type TailHandle } from '../core/ndjson-tail.js';
import { buildProgressBar } from '../utils/format.js';

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
/*  Live TUI event handler — Story 53.5                               */
/* ------------------------------------------------------------------ */

/**
 * State tracked during live attach rendering.
 * Exported for testing.
 */
export interface AttachRenderState {
  currentPhase: string;
  reviewedFiles: number;
  totalFiles: number;
  findings: Array<{ file: string; verdict: string }>;
}

/**
 * Create an event handler for ndjson events that renders TUI output.
 * Returns the handler function and the mutable state object.
 *
 * Design note (Story 53.5 AC): Progress is event-driven (file_review_end
 * increments the counter) rather than polling progress.json. This avoids
 * filesystem reads every second and provides instant updates. The progress
 * bar is re-rendered on each file_review_end event.
 */
export function createAttachEventHandler(): {
  handleEvent: (event: unknown) => void;
  state: AttachRenderState;
} {
  const state: AttachRenderState = {
    currentPhase: '',
    reviewedFiles: 0,
    totalFiles: 0,
    findings: [],
  };

  function handleEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const ev = event as Record<string, unknown>;
    const eventType = ev.event as string | undefined;
    if (!eventType) return;

    switch (eventType) {
      case 'phase_start': {
        const phase = ev.phase as string;
        state.currentPhase = phase;
        console.log(chalk.dim(`  ▸ phase: ${phase}`));
        break;
      }

      case 'phase_end': {
        const phase = ev.phase as string;
        const durationMs = ev.durationMs as number | undefined;
        const durStr = durationMs != null ? ` (${Math.round(durationMs / 1000)}s)` : '';
        console.log(chalk.dim(`  ▹ phase: ${phase} done${durStr}`));
        state.currentPhase = '';
        break;
      }

      case 'file_review_end': {
        const file = (ev.file as string) ?? '?';
        const verdict = (ev.verdict as string) ?? '?';
        state.reviewedFiles++;
        state.findings.push({ file, verdict });

        // Render progress bar
        if (state.totalFiles > 0) {
          const bar = buildProgressBar(state.reviewedFiles, state.totalFiles, 30);
          const pct = Math.round((state.reviewedFiles / state.totalFiles) * 100);
          process.stdout.write(`\r  progress    ${bar} ${pct}% (${state.reviewedFiles}/${state.totalFiles})`);
        }

        // Render finding line
        const verdictLabel = verdict === 'CLEAN' ? chalk.green(verdict) :
                             verdict === 'ERROR' ? chalk.red(verdict) :
                             chalk.yellow(verdict);
        console.log(`  ${verdictLabel}  ${chalk.dim(file)}`);
        break;
      }

      case 'estimate_total': {
        // Custom event emitted at start of review phase with total file count
        // Fallback: extract from phase_end of estimate
        state.totalFiles = (ev.total as number) ?? state.totalFiles;
        break;
      }

      default:
        // Check if this is the run_started event with file count
        if (ev.concurrency != null) {
          // run started event — ignore
        }
        break;
    }
  }

  return { handleEvent, state };
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
      console.log('');

      // Start tailing ndjson — Story 53.5
      const { handleEvent } = createAttachEventHandler();
      const fromStart = opts?.fromStart ?? false;

      const tailHandle: TailHandle = tailNdjson(logPath, {
        fromStart,
        onEvent: handleEvent,
        onError: (err) => {
          console.error(chalk.dim(`  warning: ${err.message}`));
        },
      });

      // Termination handling will be added in Story 53.6.
      // For now, just handle SIGINT to stop cleanly.
      process.on('SIGINT', () => {
        tailHandle.stop();
        console.log('');
        console.log(`  detached from run ${result.runId}`);
        process.exit(130);
      });
    });
}
