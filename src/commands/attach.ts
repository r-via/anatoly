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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { listRunStatuses, readRunStatus, isProcessAlive, writeRunStatus, type RunStatus } from '../core/run/index.js';
import { resolveRunDir } from '../utils/run-id.js';
import { tailNdjson, type TailHandle } from '../core/run/index.js';
import { formatDuration, verdictColor } from '../utils/format.js';
import { loadReviews, computeGlobalVerdict, renderDocModeLine } from '../core/reporting/index.js';
import { loadConfig } from '../utils/config-loader.js';
import { ProgressManager } from '../core/run/index.js';
import { resolveDocMode } from '../core/run/index.js';

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
      message: `Run "${runId}" has no status information.`,
      exitCode: 1,
    };
  }

  // If marked running but PID is dead, reconcile to crashed on disk.
  if (status.status === 'running' && !isProcessAlive(status.pid)) {
    status.status = 'crashed';
    status.completedAt = new Date().toISOString();
    writeRunStatus(runDir, status);
  }

  return { ok: true, runId: status.runId, runDir, status };
}

function resolveAutoRun(projectRoot: string): ResolveResult {
  const allStatuses = listRunStatuses(projectRoot);
  const activeRuns = allStatuses.filter((s) => s.status === 'running' && isProcessAlive(s.pid));

  if (activeRuns.length === 0) {
    return {
      ok: false,
      message: "No active run found. Use 'anatoly runs list' to see all runs, or 'anatoly runs attach <runId>' to inspect a finished one.",
      exitCode: 1,
    };
  }

  if (activeRuns.length > 1) {
    const runList = activeRuns.map((s) => `  - ${s.runId}`).join('\n');
    return {
      ok: false,
      message: `Multiple active runs:\n${runList}\nSpecify a run ID with: anatoly runs attach <runId>`,
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
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Live state snapshot — derives phase/progress at attach time       */
/* ------------------------------------------------------------------ */

/**
 * Scan the ndjson log to find the most recent phase whose `phase_start`
 * has no matching `phase_end`. Returns null if no phases are open.
 *
 * Reads the file as a whole — typical runs produce ndjson under a few MB
 * and this only runs once at attach time, not in the hot path.
 */
export function readCurrentPhase(logPath: string): string | null {
  if (!existsSync(logPath)) return null;
  let content: string;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch {
    return null;
  }

  const openPhases: string[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const eventType = ev.event as string | undefined;
    const phase = ev.phase as string | undefined;
    if (!phase) continue;
    if (eventType === 'phase_start') {
      openPhases.push(phase);
    } else if (eventType === 'phase_end') {
      const idx = openPhases.lastIndexOf(phase);
      if (idx >= 0) openPhases.splice(idx, 1);
    }
  }
  return openPhases.length > 0 ? openPhases[openPhases.length - 1] : null;
}

/** Snapshot data computed at attach time, used to render the initial state. */
export interface LiveSnapshot {
  phase: string | null;
  reviewedFiles: number;
  totalFiles: number;
  elapsedMs: number;
  /**
   * In-flight RAG sub-phase progress (e.g. `code 196/196`, `nlp 42/196`).
   * Set during `rag-index`; never set during `review`. The renderer uses
   * this to show meaningful progress before `file_review_end` events start
   * arriving — otherwise the status line is stuck at `0/<totalFiles>`.
   */
  ragProgress?: { phase: string; current: number; total: number };
}

/**
 * Build the initial "what's happening right now" block printed once on
 * attach, before the live tail starts streaming.
 */
export function buildLiveSnapshot(snapshot: LiveSnapshot): string {
  const lines: string[] = [];
  lines.push(`  phase       ${snapshot.phase ?? '—'}`);
  // Prefer the live rag sub-phase counter (e.g. nlp 42/196) when we're not
  // yet in review — otherwise `reviewedFiles/totalFiles` would lie with 0/N.
  if (snapshot.ragProgress) {
    const { phase, current, total } = snapshot.ragProgress;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    lines.push(`  progress    rag ${phase} ${current}/${total} (${pct}%)`);
  } else if (snapshot.reviewedFiles > 0 && snapshot.totalFiles > 0) {
    const pct = Math.round((snapshot.reviewedFiles / snapshot.totalFiles) * 100);
    lines.push(`  progress    ${snapshot.reviewedFiles}/${snapshot.totalFiles} (${pct}%)`);
  } else if (snapshot.totalFiles > 0) {
    lines.push(`  progress    waiting for review phase (${snapshot.totalFiles} files queued)`);
  } else {
    lines.push(`  progress    — (not yet estimated)`);
  }
  lines.push(`  elapsed     ${formatDuration(snapshot.elapsedMs)}`);
  return lines.join('\n');
}

/**
 * One-line status renderer for live refresh at the bottom of the attach
 * output. Designed to coexist with scrolling event lines via the
 * `clear-and-rewrite` pattern (\r + ANSI clear-line).
 */
export function buildStatusLine(snapshot: LiveSnapshot): string {
  const parts: string[] = [];
  parts.push(`phase: ${snapshot.phase ?? '—'}`);
  if (snapshot.ragProgress) {
    const { phase, current, total } = snapshot.ragProgress;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    parts.push(`rag ${phase} ${current}/${total} (${pct}%)`);
  } else if (snapshot.reviewedFiles > 0 && snapshot.totalFiles > 0) {
    const pct = Math.round((snapshot.reviewedFiles / snapshot.totalFiles) * 100);
    parts.push(`${snapshot.reviewedFiles}/${snapshot.totalFiles} (${pct}%)`);
  } else if (snapshot.totalFiles > 0) {
    parts.push(`waiting on review phase`);
  } else {
    parts.push(`waiting on estimate`);
  }
  parts.push(`elapsed ${formatDuration(snapshot.elapsedMs)}`);
  return `  ${parts.join(' · ')}`;
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
  /** Live rag-index sub-phase progress, populated from `rag_progress` events. */
  ragProgress?: { phase: string; current: number; total: number };
}

/**
 * Format the inline `[ 12/128]` counter prefix used on each file line.
 * The numerator is padded so columns stay aligned as count grows.
 */
function formatCounter(current: number, total: number): string {
  if (total <= 0) return `[${String(current).padStart(3)}    ]`;
  const w = String(total).length;
  return `[${String(current).padStart(w)}/${total}]`;
}

const VERDICT_LABEL_WIDTH = 14; // widest known label "NEEDS_REFACTOR"

function colorVerdict(verdict: string): string {
  if (verdict === 'CLEAN') return chalk.green(verdict);
  if (verdict === 'ERROR') return chalk.red(verdict);
  return chalk.yellow(verdict);
}

/**
 * Create an event handler for ndjson events that renders TUI output.
 * Returns the handler function and the mutable state object.
 *
 * Design note: progress is event-driven. Each `file_review_end` prints a
 * single line carrying its own `[N/M]` counter — there is no separate
 * persistent progress bar (the previous `\r`-based bar was overwritten by
 * the verdict line that followed it). The counter scrolls with history,
 * which is what an attach session actually needs.
 *
 * `totalFiles` may be pre-seeded from progress.json at attach time so the
 * counter is meaningful even when the user joins after `estimate_total`
 * already fired.
 */
export function createAttachEventHandler(initial?: { totalFiles?: number; reviewedFiles?: number; onLineEmitted?: () => void }): {
  handleEvent: (event: unknown) => void;
  state: AttachRenderState;
} {
  const state: AttachRenderState = {
    currentPhase: '',
    reviewedFiles: initial?.reviewedFiles ?? 0,
    totalFiles: initial?.totalFiles ?? 0,
    findings: [],
  };

  function emit(line: string): void {
    console.log(line);
    initial?.onLineEmitted?.();
  }

  function handleEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const ev = event as Record<string, unknown>;
    const eventType = ev.event as string | undefined;
    if (!eventType) return;

    switch (eventType) {
      case 'phase_start': {
        const phase = ev.phase as string;
        state.currentPhase = phase;
        emit(chalk.cyan(`  ▸ phase: ${phase}`));
        break;
      }

      case 'phase_end': {
        const phase = ev.phase as string;
        const durationMs = ev.durationMs as number | undefined;
        const durStr = durationMs != null ? ` (${Math.round(durationMs / 1000)}s)` : '';
        emit(chalk.dim(`  ▹ phase: ${phase} done${durStr}`));
        state.currentPhase = '';
        // Drop the live rag sub-counter when the rag-index phase wraps up
        // so it doesn't linger into the review phase's status line.
        if (phase === 'rag-index') state.ragProgress = undefined;
        break;
      }

      case 'file_review_end': {
        const file = (ev.file as string) ?? '?';
        const verdict = (ev.verdict as string) ?? '?';
        state.reviewedFiles++;
        state.findings.push({ file, verdict });

        const counter = chalk.dim(formatCounter(state.reviewedFiles, state.totalFiles));
        const verdictLabel = colorVerdict(verdict).padEnd(VERDICT_LABEL_WIDTH + 9); // +9 ANSI escape budget
        emit(`  ${counter} ${verdictLabel} ${chalk.dim(file)}`);
        break;
      }

      case 'estimate_total': {
        state.totalFiles = (ev.total as number) ?? state.totalFiles;
        break;
      }

      case 'rag_progress': {
        const subphase = ev.subphase as string | undefined;
        const current = ev.current as number | undefined;
        const total = ev.total as number | undefined;
        if (subphase && typeof current === 'number' && typeof total === 'number') {
          state.ragProgress = { phase: subphase, current, total };
        }
        break;
      }

      // doc 15: surface the non-audited / cache-skip cases so the live view
      // does not lie by omission. Cache-hit and skip-tier files already show
      // (they emit file_review_end); stale-task drops emit nothing reviewable
      // and were previously invisible in attach.
      case 'file_cache_miss': {
        const file = (ev.file as string) ?? '?';
        emit(chalk.yellow(`  ⚠ cache-miss ${chalk.dim(file)} → re-evaluating (no cached review for current axes)`));
        break;
      }

      case 'stale_task_dropped': {
        const dropped = Array.isArray(ev.dropped) ? (ev.dropped as string[]) : [];
        const n = (ev.droppedCount as number) ?? dropped.length;
        const shown = dropped.slice(0, 8).join(', ');
        const more = n > 8 ? ` (+${n - 8} more)` : '';
        emit(chalk.yellow(`  ⚠ ${n} stale task(s) dropped — NOT reviewed this run: ${chalk.dim(shown)}${more}`));
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
  breakdown: FindingsBreakdown,
  reportPath: string | null,
  docMode?: 'full' | 'lite' | 'off',
): { message: string; exitCode: number } {
  const lines: string[] = [];
  lines.push('  ' + '─'.repeat(60));

  if (status.status === 'done') {
    const duration = status.completedAt
      ? formatDuration(new Date(status.completedAt).getTime() - new Date(status.startedAt).getTime())
      : '—';
    lines.push(`  verdict     ${verdictColor(verdict)}`);
    lines.push(`  findings    ${breakdown.total}`);
    pushBreakdownLines(lines, breakdown);
    lines.push(`  duration    ${duration}`);
    if (docMode) {
      lines.push(`  docs        ${renderDocModeLine({ mode: docMode })}`);
    }
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

/**
 * Build a snapshot view for a terminated run (done / failed / crashed).
 * Exported for testing.
 */
/** Per-axis tally of findings shown in attach summaries. */
export interface FindingsBreakdown {
  total: number;
  dead: number;
  dup: number;
  over: number;
  errors: number;
}

/** Compute the per-axis breakdown across all reviews of a run. */
export function computeFindingsBreakdown(
  reviews: ReadonlyArray<{ symbols: ReadonlyArray<{ utility?: string; duplication?: string; overengineering?: string; correction?: string }> }>,
): FindingsBreakdown {
  let dead = 0, dup = 0, over = 0, errors = 0;
  for (const review of reviews) {
    for (const s of review.symbols) {
      if (s.utility === 'DEAD') dead++;
      if (s.duplication === 'DUPLICATE') dup++;
      if (s.overengineering === 'OVER') over++;
      if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') errors++;
    }
  }
  return { total: dead + dup + over + errors, dead, dup, over, errors };
}

/** Append the axis breakdown lines (only those with count > 0). */
function pushBreakdownLines(lines: string[], b: FindingsBreakdown): void {
  if (b.dead > 0) lines.push(`    dead      ${b.dead}`);
  if (b.dup > 0) lines.push(`    dup       ${b.dup}`);
  if (b.over > 0) lines.push(`    over      ${b.over}`);
  if (b.errors > 0) lines.push(`    errors    ${b.errors}`);
}

export function buildTerminatedSnapshot(
  status: RunStatus,
  verdict: string,
  breakdown: FindingsBreakdown,
  reportPath: string | null,
  docMode?: 'full' | 'lite' | 'off',
): string {
  const lines: string[] = [];
  const duration = status.completedAt
    ? formatDuration(new Date(status.completedAt).getTime() - new Date(status.startedAt).getTime())
    : '—';

  lines.push(`  run         ${status.runId}`);
  lines.push(`  status      ${status.status}`);
  lines.push(`  started     ${status.startedAt}`);
  if (status.completedAt) lines.push(`  completed   ${status.completedAt}`);
  lines.push(`  duration    ${duration}`);
  if (status.branch) lines.push(`  branch      ${status.branch}`);
  if (status.commit) lines.push(`  commit      ${status.commit}`);
  if (status.error) lines.push(`  error       ${status.error}`);

  if (status.status === 'done') {
    lines.push(`  verdict     ${verdictColor(verdict)}`);
    lines.push(`  findings    ${breakdown.total}`);
    pushBreakdownLines(lines, breakdown);
  }

  if (docMode) {
    lines.push(`  docs        ${renderDocModeLine({ mode: docMode })}`);
  }

  lines.push(`  report      ${reportPath ?? '(not generated)'}`);
  return lines.join('\n');
}

/** Registers the `attach` CLI sub-command on the given Commander parent (`runs`). */
export function registerAttachCommand(parent: Command): void {
  parent
    .command('attach [runId]')
    .description('Inspect a run — live tail if running, snapshot if finished')
    .option('--from-start', 'replay log from the beginning instead of tail-only')
    .option('--no-color', 'disable colors for piping')
    .action(async (runId?: string, opts?: { fromStart?: boolean }) => {
      const projectRoot = process.cwd();
      const result = resolveAttachTarget(projectRoot, runId);

      if (!result.ok) {
        console.error(result.message);
        process.exit(result.exitCode);
      }

      // Branch on run state: live tail for running, snapshot for terminated.
      if (result.status.status !== 'running') {
        console.log(chalk.bold('anatoly — runs attach'));
        console.log('');

        let verdict = 'CLEAN';
        let breakdown: FindingsBreakdown = { total: 0, dead: 0, dup: 0, over: 0, errors: 0 };
        let reportPath: string | null = null;

        if (result.status.status === 'done') {
          const reviews = loadReviews(projectRoot, result.runDir);
          verdict = computeGlobalVerdict(reviews);
          breakdown = computeFindingsBreakdown(reviews);
          const rp = resolve(result.runDir, 'report.md');
          if (existsSync(rp)) reportPath = rp;
        }

        let docMode: 'full' | 'lite' | 'off' | undefined;
        try {
          const config = loadConfig(projectRoot);
          docMode = resolveDocMode(config);
        } catch {
          // Config not available — omit doc mode line
        }

        console.log(buildTerminatedSnapshot(result.status, verdict, breakdown, reportPath, docMode));

        // Exit code: CLEAN done → 0, done with findings or failed → 1, crashed → 2.
        if (result.status.status === 'done') {
          process.exit(verdict === 'CLEAN' ? 0 : 1);
        }
        if (result.status.status === 'crashed') {
          process.exit(2);
        }
        process.exit(1);
      }

      const logPath = join(result.runDir, 'anatoly.ndjson');

      // Print header
      console.log(chalk.bold('anatoly — runs attach'));
      console.log('');
      console.log(buildAttachHeader(result.status, logPath));
      console.log('');

      // Snapshot of current run state — so the user sees the phase/progress
      // immediately, even if `estimate_total` fired before they attached.
      let snapshotTotal = 0;
      let snapshotReviewed = 0;
      try {
        const pm = new ProgressManager(projectRoot);
        const summary = pm.getSummary();
        snapshotTotal = pm.totalFiles();
        snapshotReviewed = summary.DONE + summary.CACHED;
      } catch {
        // progress.json missing or unreadable — leave counts at 0
      }
      const currentPhase = readCurrentPhase(logPath);
      console.log('  ' + chalk.dim('─'.repeat(60)));
      console.log('  ' + chalk.dim('(Press Ctrl-C to detach — does not stop the run)'));
      console.log('');

      // Live status line — single line at the bottom that refreshes in
      // place via \r + ANSI clear-line. Events from the tail handler
      // clear this line before printing themselves, then it's redrawn.
      // A 1s timer also refreshes it so elapsed time advances visually
      // even when no event fires.
      const startedAtMs = new Date(result.status.startedAt).getTime();
      let statusLineDrawn = false;

      function clearStatusLine(): void {
        if (!statusLineDrawn) return;
        process.stdout.write('\r\x1b[K');
        statusLineDrawn = false;
      }

      function drawStatusLine(): void {
        const snap: LiveSnapshot = {
          phase: state.currentPhase || readCurrentPhase(logPath),
          reviewedFiles: state.reviewedFiles,
          totalFiles: state.totalFiles,
          elapsedMs: Date.now() - startedAtMs,
          ragProgress: state.ragProgress,
        };
        process.stdout.write('\r\x1b[K' + chalk.cyan(buildStatusLine(snap)));
        statusLineDrawn = true;
      }

      // Start tailing ndjson — Story 53.5
      const { handleEvent, state } = createAttachEventHandler({
        totalFiles: snapshotTotal,
        reviewedFiles: snapshotReviewed,
        // Each emitted event line is preceded by a status-line clear and
        // followed by a redraw — so the status always sits below history.
        onLineEmitted: () => {
          drawStatusLine();
        },
      });

      // Seed currentPhase from the ndjson snapshot so the very first
      // status-line draw shows the right phase before any new event fires.
      if (currentPhase) state.currentPhase = currentPhase;

      // Initial draw + periodic refresh for elapsed time.
      drawStatusLine();
      const refreshTimer = setInterval(() => {
        // Re-read the current phase opportunistically — useful when the
        // run is between events but inside a long-running phase.
        const livePhase = state.currentPhase || readCurrentPhase(logPath);
        if (livePhase) state.currentPhase = livePhase;
        drawStatusLine();
      }, 1000);

      const fromStart = opts?.fromStart ?? false;
      const tailHandle: TailHandle = tailNdjson(logPath, {
        fromStart,
        onEvent: (ev) => {
          clearStatusLine();
          handleEvent(ev);
        },
        onError: (err) => {
          clearStatusLine();
          console.error(chalk.dim(`  warning: ${err.message}`));
          drawStatusLine();
        },
      });

      // Termination handling — Story 53.6
      const abortController = new AbortController();

      // SIGINT handler: detach cleanly without affecting the run
      process.on('SIGINT', () => {
        tailHandle.stop();
        clearInterval(refreshTimer);
        clearStatusLine();
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

      // Stop tailing + clean up refresh timer + status line
      tailHandle.stop();
      clearInterval(refreshTimer);
      clearStatusLine();

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
      let breakdown: FindingsBreakdown = { total: 0, dead: 0, dup: 0, over: 0, errors: 0 };
      let reportPath: string | null = null;

      if (finalStatus.status === 'done') {
        const reviews = loadReviews(projectRoot, result.runDir);
        verdict = computeGlobalVerdict(reviews);
        breakdown = computeFindingsBreakdown(reviews);
        const rp = resolve(result.runDir, 'report.md');
        if (existsSync(rp)) reportPath = rp;
      }

      let docMode: 'full' | 'lite' | 'off' | undefined;
      try {
        const config = loadConfig(projectRoot);
        docMode = resolveDocMode(config);
      } catch {
        // Config not available — omit doc mode line
      }

      console.log('');
      const finalization = buildFinalizationMessage(finalStatus, verdict, breakdown, reportPath, docMode);
      console.log(finalization.message);
      process.exit(finalization.exitCode);
    });
}
