// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';
import type { ReviewFile } from '../schemas/review.js';

/**
 * Build a Unicode progress bar using filled (█) and empty (░) block characters.
 *
 * The ratio is clamped to [0, 1] so values of `current` exceeding `total`
 * produce a full bar, and negative values produce an empty bar.
 *
 * @param current - Number of completed items.
 * @param total - Total number of items. When 0, returns an all-empty bar.
 * @param width - Character width of the bar (default 20).
 * @returns A string of length `width` composed of █ and ░ characters.
 */
export function buildProgressBar(current: number, total: number, width: number = 20): string {
  if (total === 0) return '░'.repeat(width);
  const ratio = Math.min(current / total, 1);
  const filled = Math.max(0, Math.round(ratio * width));
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Colorize a verdict string for terminal display.
 *
 * Maps known verdicts to chalk colours: CLEAN → green, NEEDS_REFACTOR → yellow,
 * CRITICAL → red. Unknown values are returned as-is without colour.
 *
 * @param verdict - The verdict string to colorize (e.g. 'CLEAN', 'NEEDS_REFACTOR', 'CRITICAL').
 * @returns The verdict wrapped in ANSI colour codes, or the raw string for unknown values.
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
 * Count actionable findings across all symbols in a review file.
 *
 * Tallies symbols that trigger any of eight axis conditions (DEAD utility,
 * DUPLICATE duplication, OVER overengineering, NEEDS_FIX/ERROR correction,
 * WEAK/NONE tests, UNDOCUMENTED exported documentation, and PARTIAL
 * documentation) plus best-practices rules with FAIL status. Symbols below
 * the given confidence threshold are skipped entirely.
 *
 * @param review - The parsed review file containing symbols and optional best_practices.
 * @param minConfidence - Minimum confidence (0-100) a symbol must have to be
 *   counted; defaults to 0 (include all symbols).
 * @returns The total number of actionable findings.
 */
export function countReviewFindings(review: ReviewFile, minConfidence: number = 0): number {
  let findings = 0;
  for (const s of review.symbols) {
    if (s.confidence < minConfidence) continue;
    if (s.utility === 'DEAD') findings++;
    if (s.duplication === 'DUPLICATE') findings++;
    if (s.overengineering === 'OVER') findings++;
    if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') findings++;
    if (s.tests === 'WEAK' || s.tests === 'NONE') findings++;
    if (s.exported && s.documentation === 'UNDOCUMENTED') findings++;
    if (s.documentation === 'PARTIAL') findings++;
  }
  if (review.best_practices) {
    findings += review.best_practices.rules.filter((r) => r.status === 'FAIL').length;
  }
  return findings;
}
