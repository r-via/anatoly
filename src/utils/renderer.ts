import chalk from 'chalk';
import ora from 'ora';
import logUpdate from 'log-update';
import type { Verdict } from '../schemas/review.js';

export interface RendererOptions {
  plain?: boolean;
  version?: string;
}

export interface Counters {
  dead: number;
  duplicate: number;
  overengineering: number;
  error: number;
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
 * Build a Unicode progress bar.
 */
export function buildProgressBar(current: number, total: number, width: number = 20): string {
  if (total === 0) return '░'.repeat(width);
  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Format a counter row: dead N  dup N  over N  err N
 */
export function formatCounterRow(counters: Counters, useColor: boolean = true): string {
  const fmt = (label: string, value: number, color: (s: string) => string): string => {
    const v = String(value);
    if (!useColor) return `${label} ${v}`;
    return `${chalk.bold(label)} ${value > 0 ? color(v) : chalk.dim(v)}`;
  };

  return [
    fmt('dead', counters.dead, chalk.yellow),
    fmt('dup', counters.duplicate, chalk.yellow),
    fmt('over', counters.overengineering, chalk.yellow),
    fmt('err', counters.error, chalk.red),
  ].join('  ');
}

/**
 * Format a file result line: ✓ filename  VERDICT
 */
export function formatResultLine(filename: string, verdict: Verdict, findings?: string, useColor: boolean = true): string {
  const mark = useColor ? chalk.green('✓') : 'OK';
  const name = useColor ? chalk.dim(filename) : filename;
  const suffix = findings ? ` ${findings}` : '';

  let verdictStr: string;
  if (!useColor) {
    verdictStr = verdict + suffix;
  } else {
    switch (verdict) {
      case 'CLEAN':
        verdictStr = chalk.green(verdict) + suffix;
        break;
      case 'NEEDS_REFACTOR':
        verdictStr = chalk.yellow(verdict) + suffix;
        break;
      case 'CRITICAL':
        verdictStr = chalk.red(verdict) + suffix;
        break;
      default:
        verdictStr = verdict + suffix;
    }
  }

  return `${mark} ${name}  ${verdictStr}`;
}

/**
 * Colorize a verdict string for terminal display.
 */
export function verdictColor(verdict: string): string {
  switch (verdict) {
    case 'CLEAN':
      return chalk.green(verdict);
    case 'NEEDS_REFACTOR':
      return chalk.yellow(verdict);
    case 'CRITICAL':
      return chalk.red(verdict);
    default:
      return verdict;
  }
}

/**
 * Truncate a file path to fit within maxLen characters.
 */
export function truncatePath(filePath: string, maxLen: number): string {
  if (filePath.length <= maxLen) return filePath;
  const parts = filePath.split('/');
  if (parts.length <= 2) return '...' + filePath.slice(filePath.length - maxLen + 3);
  // Keep first and last parts, replace middle with ...
  const first = parts[0];
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  const result = `${first}/.../${secondLast}/${last}`;
  if (result.length <= maxLen) return result;
  return '...' + filePath.slice(filePath.length - maxLen + 3);
}

/**
 * Create a renderer that auto-detects TTY mode.
 */
export function createRenderer(options: RendererOptions = {}): Renderer {
  const isPlain = options.plain ?? !process.stdout.isTTY;
  const version = options.version ?? 'unknown';

  if (isPlain) {
    return createPlainRenderer(version);
  }
  return createInteractiveRenderer(version);
}

function createPlainRenderer(version: string): Renderer {
  const counters: Counters = { dead: 0, duplicate: 0, overengineering: 0, error: 0 };

  return {
    start(_total: number) {
      console.log(`anatoly v${version}`);
      console.log('');
    },

    updateProgress(current: number, total: number, currentFile: string) {
      console.log(`  reviewing ${currentFile} (${current}/${total})`);
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

function createInteractiveRenderer(version: string): Renderer {
  const counters: Counters = { dead: 0, duplicate: 0, overengineering: 0, error: 0 };
  const results: string[] = [];
  let spinner: ReturnType<typeof ora> | null = null;
  let currentTotal = 0;
  let currentProgress = 0;
  let currentFile = '';

  // Multi-file worker slots: workerIndex → filePath (null = idle)
  const workerSlots = new Map<number, string>();

  function renderFixedZone(): string {
    const lines: string[] = [];
    lines.push(chalk.bold(`anatoly v${version}`));
    lines.push('');

    // Multi-file mode: show worker slots
    if (workerSlots.size > 0) {
      const sortedSlots = [...workerSlots.entries()].sort((a, b) => a[0] - b[0]);
      for (const [idx, filePath] of sortedSlots) {
        lines.push(`  [${idx + 1}] reviewing ${chalk.cyan(filePath)}`);
      }
    } else if (currentFile) {
      // Single-file fallback
      lines.push(`  ⠋ reviewing ${chalk.cyan(currentFile)}`);
    }

    const bar = buildProgressBar(currentProgress, currentTotal);
    lines.push(`  progress ${bar}  ${currentProgress}/${currentTotal}`);
    lines.push('');
    lines.push(`  ${formatCounterRow(counters)}`);

    return lines.join('\n');
  }

  function render() {
    const fixedZone = renderFixedZone();
    // Flow zone: last N results that fit
    const flowLines = results.slice(-15);
    const flowZone = flowLines.length > 0 ? '\n' + flowLines.join('\n') : '';
    logUpdate(fixedZone + flowZone);
  }

  return {
    start(total: number) {
      currentTotal = total;
      spinner = ora({ text: '', spinner: 'dots', stream: process.stderr });
      spinner.start();
      render();
    },

    updateProgress(current: number, total: number, file: string) {
      currentProgress = current;
      currentTotal = total;
      currentFile = file;
      render();
    },

    addResult(filename: string, verdict: Verdict, findings?: string) {
      results.push('  ' + formatResultLine(filename, verdict, findings));
      render();
    },

    incrementCounter(key: keyof Counters, amount: number = 1) {
      counters[key] += amount;
      render();
    },

    showCompletion(stats, paths) {
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
      logUpdate.clear();

      console.log(chalk.bold(`review complete`) + ` — ${stats.reviewed} files | ${stats.findings} findings | ${stats.clean} clean`);
      console.log('');
      console.log(`  report       ${chalk.cyan(paths.report)}`);
      console.log(`  reviews      ${chalk.cyan(paths.reviews)}`);
      console.log(`  transcripts  ${chalk.cyan(paths.logs)}`);
    },

    stop() {
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
      logUpdate.clear();
    },

    updateWorkerSlot(workerIndex: number, filePath: string) {
      workerSlots.set(workerIndex, filePath);
      render();
    },

    clearWorkerSlot(workerIndex: number) {
      workerSlots.delete(workerIndex);
      render();
    },

    log(message: string) {
      logUpdate.clear();
      console.log(message);
      render();
    },
  };
}
