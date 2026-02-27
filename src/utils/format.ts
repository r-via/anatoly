import chalk from 'chalk';

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
 * @deprecated Use `getLogger().debug()` from `src/utils/logger.ts` instead.
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

