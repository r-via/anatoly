// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';

/**
 * Standardised launch-time notices printed just below the banner.
 *
 * Centralising format here keeps the various warnings, info hints, and
 * fatal errors that surface before the pipeline summary visually
 * consistent instead of each call site emitting its own ad-hoc dim /
 * yellow / red `console.log`.
 */

export type NoticeKind = 'info' | 'warn' | 'error' | 'success';

type Tint = (s: string) => string;

const STYLE: Record<NoticeKind, { icon: string; tint: Tint; titleTint: Tint }> = {
  info: { icon: 'ℹ', tint: chalk.cyan, titleTint: chalk.cyan.bold },
  warn: { icon: '⚠', tint: chalk.yellow, titleTint: chalk.yellow.bold },
  error: { icon: '✖', tint: chalk.red, titleTint: chalk.red.bold },
  success: { icon: '✔', tint: chalk.green, titleTint: chalk.green.bold },
};

export interface NoticeOptions {
  kind: NoticeKind;
  /** One-line headline. */
  title: string;
  /** Optional secondary lines printed below the title (rendered dim). */
  details?: string[];
  /** Optional actionable next step, rendered as "→ <hint>". */
  hint?: string;
}

/**
 * Render a notice as a multi-line string with consistent styling.
 *
 * Layout:
 * ```
 *   <icon>  <title>
 *      <detail-line-1>
 *      <detail-line-2>
 *      → <hint>
 * ```
 */
export function renderNotice({ kind, title, details, hint }: NoticeOptions): string {
  const { icon, tint, titleTint } = STYLE[kind];
  const lines: string[] = [];
  lines.push(`  ${tint(icon)}  ${titleTint(title)}`);
  if (details && details.length > 0) {
    for (const line of details) {
      lines.push(`     ${chalk.dim(line)}`);
    }
  }
  if (hint) {
    lines.push(`     ${chalk.dim('→')} ${hint}`);
  }
  return lines.join('\n');
}

/** Print a notice followed by a blank line. */
export function printNotice(opts: NoticeOptions): void {
  console.log(renderNotice(opts));
  console.log('');
}
