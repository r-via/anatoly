import chalk from 'chalk';
import type { Verdict } from '../schemas/review.js';

export interface Counters {
  dead: number;
  duplicate: number;
  overengineering: number;
  error: number;
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
