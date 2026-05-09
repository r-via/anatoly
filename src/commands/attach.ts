// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `anatoly attach [runId]` — Stories 53.4 + 53.5 + 53.6
 *
 * Attaches a read-only viewer to a running audit.
 * Story 53.4: run resolution and header display.
 * Story 53.5: ndjson tail + TUI live rendering + --from-start.
 * Story 53.6: clean termination + crash detection.
 */

import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { listRunStatuses, readRunStatus, isProcessAlive, writeRunStatus, type RunStatus } from '../core/run-status.js';
import { resolveRunDir } from '../utils/run-id.js';
import { tailNdjson, type TailHandle } from '../core/ndjson-tail.js';
import { buildProgressBar } from '../utils/format.js';
import { loadReviews, computeGlobalVerdict } from '../core/reporter.js';
import { formatDuration } from './status.js';

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
        state.totalFiles = (ev.total as number) ?? state.totalFiles;
        break;
      }

      default:
        break;
    }
  }

  return { handleEvent, state };
}

/* ------------------------------------------------------------------ */
/*  Termination handling — Story 53.6                                  */
/* ------------------------------------------------------------------ */

export interface MonitorResult {
  reason: 'status_change' | 'pid_dead' | 'aborted';
  finalStatus: RunStatus | undefined;
}

export interface MonitorOptions {
  /** How often to poll run-status.json in ms (default 1000). */
  statusPollMs?: number;
  /** How often to poll PID liveness in ms (default 2000). */
  pidPollMs?: number;
  /** AbortSignal for external cancellation (e.g. SIGINT). */
  signal?: AbortSignal;
}

/**
 * Monitor a run's status file and PID liveness.
 * Resolves when:
 * - The run-status.json indicates a non-running state (done/failed/crashed)
 * - The PID is detected as dead (writes crashed status to disk)
 * - The signal is aborted (SIGINT)
 *
 * Design choice: polling (not fs.watch) for run-status.json because
 * fs.watch is unreliable across platforms and network filesystems.
 * The 1s poll interval is low overhead for a status file.
 */
export function monitorRunStatus(
  runDir: string,
  pid: number,
  opts: MonitorOptions = {},
): Promise<MonitorResult> {
  const statusPollMs = opts.statusPollMs ?? 1000;
  const pidPollMs = opts.pidPollMs ?? 2000;

  return new Promise<MonitorResult>((resolvePromise) => {
    let resolved = false;

    function finish(result: MonitorResult): void {
      if (resolved) return;
      resolved = true;
      clearInterval(statusTimer);
      clearInterval(pidTimer);
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
      resolvePromise(result);
    }

    // Poll run-status.json
    const statusTimer = setInterval(() => {
      if (resolved) return;
      const status = readRunStatus(runDir);
      if (status && status.status !== 'running') {
        finish({ reason: 'status_change', finalStatus: status });
      }
    }, statusPollMs);

    // Poll PID liveness
    const pidTimer = setInterval(() => {
      if (resolved) return;
      if (!isProcessAlive(pid)) {
        // Mark as crashed
        const status = readRunStatus(runDir);
        if (status && status.status === 'running') {
          status.status = 'crashed';
          status.completedAt = new Date().toISOString();
          writeRunStatus(runDir, status);
          finish({ reason: 'pid_dead', finalStatus: status });
        } else {
          finish({ reason: 'pid_dead', finalStatus: status ?? undefined });
        }
      }
    }, pidPollMs);

    // Handle abort signal
    function onAbort(): void {
      finish({ reason: 'aborted', finalStatus: undefined });
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        finish({ reason: 'aborted', finalStatus: undefined });
        return;
      }
      opts.signal.addEventListener('abort', onAbort);
    }
  });
}

/**
 * Build the finalization message shown when a run ends.
 * Returns plain text message and appropriate exit code.
 */
export function buildFinalizationMessage(
  status: RunStatus,
  verdict: string,
  totalFindings: number,
  reportPath: string | null,
): { message: string; exitCode: number } {
  const lines: string[] = [];
  lines.push('  ' + '─'.repeat(60));

  if (status.status === 'done') {
    const duration = status.completedAt
      ? formatDuration(new Date(status.completedAt).getTime() - new Date(status.startedAt).getTime())
      : '—';
    lines.push(`  verdict     ${verdict}`);
    lines.push(`  findings    ${totalFindings} findings`);
    lines.push(`  duration    ${duration}`);
    if (reportPath) {
      lines.push(`  report      ${reportPath}`);
    }
    const exitCode = verdict === 'CLEAN' ? 0 : 1;
    return { message: lines.join('\n'), exitCode };
  }

  if (status.status === 'failed') {
    lines.push(`  Run failed: ${status.error ?? 'unknown error'}`);
    return { message: lines.join('\n'), exitCode: 1 };
  }

  if (status.status === 'crashed') {
    lines.push('  Run crashed (PID was alive at start of attach but died during the run)');
    return { message: lines.join('\n'), exitCode: 2 };
  }

  // Fallback
  lines.push(`  Run ended with status: ${status.status}`);
  return { message: lines.join('\n'), exitCode: 1 };
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
    .action(async (runId?: string, opts?: { fromStart?: boolean }) => {
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

      // Termination handling — Story 53.6
      const abortController = new AbortController();

      // SIGINT handler: detach cleanly without affecting the run
      process.on('SIGINT', () => {
        tailHandle.stop();
        abortController.abort();
        console.log('');
        console.log(`  detached from run ${result.runId}`);
        process.exit(130);
      });

      // Monitor run status + PID liveness
      const monitorResult = await monitorRunStatus(
        result.runDir,
        result.status.pid,
        { signal: abortController.signal },
      );

      // Stop tailing
      tailHandle.stop();

      if (monitorResult.reason === 'aborted') {
        // SIGINT already handled above
        return;
      }

      const finalStatus = monitorResult.finalStatus;
      if (!finalStatus) {
        console.error('  Could not read final run status.');
        process.exit(1);
      }

      // Compute verdict for done runs
      let verdict = 'CLEAN';
      let totalFindings = 0;
      let reportPath: string | null = null;

      if (finalStatus.status === 'done') {
        const reviews = loadReviews(projectRoot, result.runDir);
        verdict = computeGlobalVerdict(reviews);

        for (const review of reviews) {
          for (const s of review.symbols) {
            if (s.utility === 'DEAD') totalFindings++;
            if (s.duplication === 'DUPLICATE') totalFindings++;
            if (s.overengineering === 'OVER') totalFindings++;
            if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') totalFindings++;
          }
        }

        const rp = resolve(result.runDir, 'report.md');
        if (existsSync(rp)) reportPath = rp;
      }

      console.log('');
      const finalization = buildFinalizationMessage(finalStatus, verdict, totalFindings, reportPath);
      console.log(finalization.message);
      process.exit(finalization.exitCode);
    });
}
