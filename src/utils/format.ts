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

  const verdictStr = (useColor ? verdictColor(verdict) : verdict) + suffix;

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
 * Format a verbose log line with [anatoly] prefix and timestamp.
 */
export function verboseLog(message: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  process.stderr.write(`[anatoly ${ts}] ${message}\n`);
}

/**
 * Format token counts for verbose display.
 * Shows input/output tokens and cache read hit rate.
 */
export function formatTokenSummary(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): string {
  const parts = [`${inputTokens} in`, `${outputTokens} out`];
  if (cacheReadTokens > 0) {
    const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;
    const hitRate = totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 100) : 0;
    parts.push(`cache ${hitRate}%`);
  }
  return parts.join(' / ');
}

