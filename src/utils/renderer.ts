import chalk from 'chalk';
import {
  cursorSavePosition,
  cursorRestorePosition,
  cursorHide,
  cursorShow,
} from 'ansi-escapes';
import type { Verdict } from '../schemas/review.js';
import {
  type Counters,
  buildProgressBar,
  formatCounterRow,
  formatResultLine,
  truncatePath,
} from './format.js';

export type { Counters };
export { buildProgressBar, verdictColor } from './format.js';

export interface RendererOptions {
  plain?: boolean;
  version?: string;
  concurrency?: number;
}

export interface Renderer {
  /** Show header and begin rendering. */
  start(total: number): void;
  /** Update fixed zone with current file being reviewed (single-file mode). */
  updateProgress(current: number, total: number, currentFile: string): void;
  /** Append a completed file result to the flow zone. */
  addResult(filename: string, verdict: Verdict, findings?: string): void;
  /** Increment a finding counter. */
  incrementCounter(key: keyof Counters, amount?: number): void;
  /** Show completion message. */
  showCompletion(stats: { reviewed: number; findings: number; clean: number }, paths: { report: string; reviews: string; logs: string }): void;
  /** Stop the renderer (cleanup spinners, etc). */
  stop(): void;
  /** Set a worker slot to show a file being reviewed (multi-file mode). */
  updateWorkerSlot(workerIndex: number, filePath: string): void;
  /** Clear a worker slot when it finishes (multi-file mode). */
  clearWorkerSlot(workerIndex: number): void;
  /** Log a message without breaking the progress display. */
  log(message: string): void;
}

/**
 * Create a renderer that auto-detects TTY mode.
 */
export function createRenderer(options: RendererOptions = {}): Renderer {
  const isPlain = options.plain ?? !process.stdout.isTTY;
  const version = options.version ?? 'unknown';
  const concurrency = options.concurrency ?? 1;

  if (isPlain) {
    return createPlainRenderer(version);
  }
  return createPinnedRenderer(version, concurrency);
}

function createPlainRenderer(version: string): Renderer {
  const counters: Counters = { dead: 0, duplicate: 0, overengineering: 0, error: 0 };

  return {
    start(_total: number) {
      console.log(`anatoly v${version}`);
      console.log('');
    },

    updateProgress(current: number, total: number, currentFile: string) {
      console.log(`  ${currentFile} (${current}/${total})`);
    },

    addResult(filename: string, verdict: Verdict, findings?: string) {
      const suffix = findings ? ` ${findings}` : '';
      console.log(`  OK ${filename}  ${verdict}${suffix}`);
    },

    incrementCounter(key: keyof Counters, amount: number = 1) {
      counters[key] += amount;
    },

    showCompletion(stats, paths) {
      console.log('');
      console.log(`review complete — ${stats.reviewed} files | ${stats.findings} findings | ${stats.clean} clean`);
      console.log('');
      console.log(`  report       ${paths.report}`);
      console.log(`  reviews      ${paths.reviews}`);
      console.log(`  transcripts  ${paths.logs}`);
    },

    stop() {
      // No-op in plain mode
    },

    updateWorkerSlot(_workerIndex: number, _filePath: string) {
      // No-op in plain mode — updateProgress handles single-file display
    },

    clearWorkerSlot(_workerIndex: number) {
      // No-op in plain mode
    },

    log(message: string) {
      console.log(message);
    },
  };
}

// ANSI escape helpers for scroll region control
const ESC = '\x1b[';
const setScrollRegion = (top: number, bottom: number) => `${ESC}${top};${bottom}r`;
const resetScrollRegion = () => `${ESC}r`;
const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`;
const eraseLine = `${ESC}2K`;
const beginSync = '\x1b[?2026h';
const endSync = '\x1b[?2026l';

function createPinnedRenderer(_version: string, concurrency: number): Renderer {
  const counters: Counters = { dead: 0, duplicate: 0, overengineering: 0, error: 0 };
  const workerSlots = new Map<number, string>();
  let currentTotal = 0;
  let currentProgress = 0;
  let currentFile = '';

  // Layout state
  let pinnedLineCount = 0;
  let scrollBottom = 0;
  let active = false;
  let termRows = 0;
  let termCols = 0;
  const maxWorkerDisplay = Math.min(concurrency, 6);

  const stdout = process.stdout;

  function getTermSize(): { rows: number; cols: number } {
    return {
      rows: stdout.rows || 24,
      cols: stdout.columns || 80,
    };
  }

  function setupLayout(): void {
    const size = getTermSize();
    termRows = size.rows;
    termCols = size.cols;

    // K = separator(1) + worker slots + progress(1) + counters(1)
    pinnedLineCount = 1 + maxWorkerDisplay + 1 + 1;

    // Degrade if terminal is too small
    if (termRows <= pinnedLineCount + 3) {
      pinnedLineCount = 3; // separator + progress + counters only
    }

    scrollBottom = termRows - pinnedLineCount;

    let out = '';
    // Push content up to make room for pinned area
    out += '\n'.repeat(pinnedLineCount);
    out += cursorHide;
    out += setScrollRegion(1, scrollBottom);
    out += moveTo(scrollBottom, 1);
    stdout.write(out);

    drawPinnedArea();
  }

  function drawPinnedArea(): void {
    if (!active) return;

    let out = beginSync;
    out += cursorSavePosition;

    const startRow = scrollBottom + 1;
    const workerLineCount = pinnedLineCount - 3; // subtract separator, progress, counters

    // Separator
    out += moveTo(startRow, 1) + eraseLine;
    out += chalk.dim('─'.repeat(termCols));

    // Worker slots (or single-file fallback)
    let row = startRow + 1;
    if (workerLineCount > 0) {
      if (workerSlots.size > 0) {
        const sortedSlots = [...workerSlots.entries()].sort((a, b) => a[0] - b[0]);
        for (let i = 0; i < workerLineCount; i++) {
          out += moveTo(row + i, 1) + eraseLine;
          if (i < sortedSlots.length) {
            const [idx, filePath] = sortedSlots[i];
            const truncated = truncatePath(filePath, termCols - 20);
            out += `  [${idx + 1}] ${chalk.cyan(truncated)}`;
          }
        }
      } else if (currentFile) {
        out += moveTo(row, 1) + eraseLine;
        out += `  ⠋ ${chalk.cyan(truncatePath(currentFile, termCols - 20))}`;
        for (let i = 1; i < workerLineCount; i++) {
          out += moveTo(row + i, 1) + eraseLine;
        }
      } else {
        for (let i = 0; i < workerLineCount; i++) {
          out += moveTo(row + i, 1) + eraseLine;
        }
      }
    }

    // Progress bar
    const progressRow = startRow + 1 + workerLineCount;
    const bar = buildProgressBar(currentProgress, currentTotal);
    out += moveTo(progressRow, 1) + eraseLine;
    out += `  progress ${bar}  ${currentProgress}/${currentTotal}`;

    // Counters
    const counterRow = progressRow + 1;
    out += moveTo(counterRow, 1) + eraseLine;
    out += `  ${formatCounterRow(counters)}`;

    out += cursorRestorePosition;
    out += endSync;
    stdout.write(out);
  }

  function writeToScrollRegion(text: string): void {
    if (!active) return;
    let out = cursorSavePosition;
    out += moveTo(scrollBottom, 1);
    out += '\n' + text;
    out += cursorRestorePosition;
    stdout.write(out);
  }

  function onResize(): void {
    if (!active) return;
    const size = getTermSize();
    termRows = size.rows;
    termCols = size.cols;
    scrollBottom = termRows - pinnedLineCount;

    let out = resetScrollRegion();
    out += setScrollRegion(1, scrollBottom);
    out += moveTo(scrollBottom, 1);
    stdout.write(out);
    drawPinnedArea();
  }

  function cleanup(): void {
    if (!active) return;
    active = false;
    stdout.removeListener('resize', onResize);

    let out = resetScrollRegion();
    out += moveTo(termRows, 1);
    out += '\n';
    out += cursorShow;
    stdout.write(out);
  }

  return {
    start(total: number) {
      currentTotal = total;
      currentProgress = 0;
      currentFile = '';
      workerSlots.clear();
      active = true;
      setupLayout();
      stdout.on('resize', onResize);
    },

    updateProgress(current: number, total: number, file: string) {
      currentProgress = current;
      currentTotal = total;
      currentFile = file;
      drawPinnedArea();
    },

    addResult(filename: string, verdict: Verdict, findings?: string) {
      writeToScrollRegion('  ' + formatResultLine(filename, verdict, findings));
    },

    incrementCounter(key: keyof Counters, amount: number = 1) {
      counters[key] += amount;
      drawPinnedArea();
    },

    showCompletion(stats, paths) {
      cleanup();
      console.log(chalk.bold('review complete') + ` — ${stats.reviewed} files | ${stats.findings} findings | ${stats.clean} clean`);
      console.log('');
      console.log(`  report       ${chalk.cyan(paths.report)}`);
      console.log(`  reviews      ${chalk.cyan(paths.reviews)}`);
      console.log(`  transcripts  ${chalk.cyan(paths.logs)}`);
    },

    stop() {
      cleanup();
    },

    updateWorkerSlot(workerIndex: number, filePath: string) {
      workerSlots.set(workerIndex, filePath);
      drawPinnedArea();
    },

    clearWorkerSlot(workerIndex: number) {
      workerSlots.delete(workerIndex);
      drawPinnedArea();
    },

    log(message: string) {
      writeToScrollRegion(message);
    },
  };
}
