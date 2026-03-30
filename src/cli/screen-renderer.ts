// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';
import { printBanner } from '../utils/banner.js';
import type { PipelineState, FileState } from './pipeline-state.js';

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
const FLASH_DURATION_MS = 2000;
const MIN_TASK_WIDTH = 60;

function taskWidth(): number {
  const cols = process.stdout.columns || 80;
  // Leave 4 chars margin (2 indent + 2 safety); clamp between min and columns
  return Math.max(MIN_TASK_WIDTH, Math.min(cols - 4, cols));
}

function separator(): string {
  return '\u2500'.repeat(taskWidth());
}

/**
 * Terminal UI renderer for the Anatoly pipeline.
 *
 * Operates in two modes:
 * - **Fancy mode** (default): clears the screen, hides the cursor, and runs a
 *   100 ms refresh loop that redraws the banner, task list, and in-flight file
 *   status in-place using ANSI escape sequences.
 * - **Plain mode** (`opts.plain = true`): all rendering is disabled; output is
 *   emitted line-by-line via {@link logPlain}.
 *
 * Lifecycle: call {@link start} to begin rendering and {@link stop} to halt
 * the refresh interval and restore the cursor.
 */
export class ScreenRenderer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private spinFrame = 0;
  private bannerLines: string[] = [];
  private stopped = false;
  private lastLineCount = 0;
  private sigHandler: (() => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private needsFullClear = false;

  constructor(
    private state: PipelineState,
    private opts: { plain: boolean } = { plain: false },
  ) {}

  /** Clear the screen, print the banner, and begin the 100 ms refresh loop (no-op in plain mode). */
  start(): void {
    if (this.opts.plain) return;

    // Clear screen, hide cursor, and print banner once (capture for re-render)
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
    this.bannerLines = this.renderBanner();
    process.stdout.write(this.bannerLines.join('\n') + '\n');

    // Restore cursor on unexpected exit (Ctrl+C, kill, crash)
    this.sigHandler = () => { process.stdout.write('\x1b[?25h'); process.exit(130); };
    process.on('SIGINT', this.sigHandler);
    process.on('SIGTERM', this.sigHandler);

    // Re-clear on terminal resize to flush stale content from previous dimensions
    this.resizeHandler = () => { this.needsFullClear = true; };
    process.stdout.on('resize', this.resizeHandler);

    this.interval = setInterval(() => this.render(), 100);
  }

  /** Stop the refresh loop, render a final static frame, and restore the cursor (no-op in plain mode). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (!this.opts.plain) {
      // Clear the TUI screen entirely and restore cursor
      process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');

      // Print banner + completed tasks as static output (no longer refreshed)
      console.log('');
      for (const line of this.bannerLines) console.log(line);
      console.log(this.renderTasksHeader());
      console.log(`  ${separator()}`);
      for (const task of this.state.tasks) {
        if (!task.visible) continue;
        console.log(this.renderTask(task));
      }
      console.log('');

      // Print summary if available
      if (this.state.summary) {
        console.log(`  ${this.state.summary.headline}`);
        console.log(`  ${separator()}`);
        for (const p of this.state.summary.paths) {
          console.log(`  ${p.key.padEnd(13)}${p.value}`);
        }
        console.log('');
        console.log(`  ${this.state.summary.cost}`);
      }
    }
    // Clean up signal and resize handlers
    if (this.sigHandler) {
      process.removeListener('SIGINT', this.sigHandler);
      process.removeListener('SIGTERM', this.sigHandler);
      this.sigHandler = null;
    }
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  /** Log a line in plain mode (no-op in fancy mode).
   *  Uses process.stdout.write directly to avoid being silenced by
   *  GeminiTransport's console.log suppression during concurrent calls. */
  logPlain(message: string): void {
    if (this.opts.plain) {
      process.stdout.write(message + '\n');
    }
  }

  private renderBanner(): string[] {
    const lines: string[] = [];
    const origLog = console.log;
    try {
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      };
      printBanner('The weight is good !');
    } finally {
      console.log = origLog;
    }
    return lines;
  }

  private render(): void {
    this.spinFrame++;
    this.state.reapDoneFiles(FLASH_DURATION_MS);

    const lines: string[] = [];

    // Zone 1 — Banner (cached)
    lines.push('');
    lines.push(...this.bannerLines);

    // Zone 2 — Task list
    lines.push(this.renderTasksHeader());
    lines.push(`  ${separator()}`);
    for (const task of this.state.tasks) {
      if (!task.visible) continue;
      lines.push(this.renderTask(task));
    }
    lines.push('');

    // Zone 3 — Current files or Summary
    if (this.state.phase === 'summary' && this.state.summary) {
      lines.push(`  ${this.state.summary.headline}`);
      lines.push(`  ${separator()}`);
      for (const p of this.state.summary.paths) {
        lines.push(`  ${p.key.padEnd(13)}${p.value}`);
      }
      lines.push('');
      lines.push(`  ${this.state.summary.cost}`);
    } else {
      lines.push(this.renderCurrentFilesHeader());
      lines.push(`  ${separator()}`);
      const files = [...this.state.activeFiles.values()];
      if (files.length === 0) {
        // No files in flight — don't show anything extra
      } else {
        const maxPathWidth = this.getMaxPathWidth(files);
        for (const file of files) {
          lines.push(this.renderFileLine(file, maxPathWidth));
        }
      }
    }

    // Clamp to terminal height to avoid scrolling past the viewport
    const maxRows = (process.stdout.rows || 40) - 1;
    if (lines.length > maxRows) lines.length = maxRows;

    // On terminal resize, clear the entire screen to flush stale content
    if (this.needsFullClear) {
      this.needsFullClear = false;
      process.stdout.write('\x1b[2J');
    }

    // Write the full frame
    const clearLine = '\x1b[K';
    const frame = lines.map((l) => l + clearLine).join('\n');
    // Clear stale lines from previous frame if current frame is shorter
    const extraClears = Math.max(0, this.lastLineCount - lines.length);
    this.lastLineCount = lines.length;
    process.stdout.write('\x1b[H' + frame + '\n' + (clearLine + '\n').repeat(extraClears));
  }

  private renderTask(task: { status: string; label: string; detail: string }): string {
    const frame = SPINNER[this.spinFrame % SPINNER.length];
    // icon(1) + space(1) = 2 chars before content
    const innerWidth = taskWidth() - 2;
    const gap = Math.max(1, innerWidth - task.label.length - task.detail.length);
    const content = task.label + ' '.repeat(gap) + task.detail;
    switch (task.status) {
      case 'done':
        return `  ${chalk.green('\u2713')} ${content}`;
      case 'active':
        return `  ${chalk.yellow(frame)} ${content}`;
      default:
        return `  ${chalk.dim('\u00b7')} ${chalk.dim(content)}`;
    }
  }

  private renderTasksHeader(): string {
    const title = '  Pipeline';
    const router = this.state.router;
    const isUpsert = this.state.activeTaskId === 'rag-upsert';
    if (router && !isUpsert && this.state.phase !== 'summary') {
      const stats = router.getSemaphoreStats();
      const anthropic = stats.get('anthropic');
      const google = stats.get('google');
      if (anthropic && google) {
        return `${title} ${chalk.dim(`\u2014 Claude ${anthropic.active}/${anthropic.total} \u00b7 Gemini ${google.active}/${google.total}`)}`;
      }
      if (anthropic) {
        return `${title} ${chalk.dim(`\u2014 ${anthropic.active}/${anthropic.total} agents active`)}`;
      }
    }
    return title;
  }

  private renderCurrentFilesHeader(): string {
    const label = this.state.inProgressLabel || 'In progress';
    return `  ${label}`;
  }

  private renderFileLine(file: FileState, maxPathWidth: number): string {
    const frame = SPINNER[this.spinFrame % SPINNER.length];
    const isDone = file.doneAt !== undefined;
    const icon = isDone ? chalk.green('\u2713') : chalk.yellow(frame);
    const truncated = this.truncatePath(file.path, maxPathWidth);
    const padded = truncated.padEnd(maxPathWidth);

    let line = `  ${icon} ${padded}`;

    if (file.axesTotal > 0) {
      const remaining = file.axesTotal - file.axesDone;
      if (isDone) {
        line += `    ${chalk.green('Done !')}`;
      } else if (remaining === 0) {
        line += `    ${chalk.dim('deliberating…')}`;
      } else {
        const counter = `${remaining}/${file.axesTotal} checks left`;
        line += `    ${counter}`;
      }
    }

    if (file.retryMsg && !isDone) {
      line += `    ${chalk.yellow(file.retryMsg)}`;
    }

    return line;
  }

  private getMaxPathWidth(files: FileState[]): number {
    const columns = process.stdout.columns || 100;
    // Reserve space for: indent(2) + icon(2) + gap(4) + axes counter(~18) + retry msg(~12) + padding(2)
    const maxAllowed = Math.max(20, columns - 40);
    const maxNatural = files.length > 0
      ? Math.max(...files.map((f) => f.path.length))
      : 30;
    return Math.min(maxNatural, maxAllowed);
  }

  private truncatePath(path: string, maxWidth: number): string {
    if (path.length <= maxWidth) return path;
    return '\u2026' + path.slice(path.length - maxWidth + 1);
  }
}
