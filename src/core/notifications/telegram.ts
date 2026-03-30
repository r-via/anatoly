// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { NotificationChannel, NotificationPayload } from './index.js';

const TELEGRAM_MAX_LENGTH = 4096;

/** Escape special characters for Telegram MarkdownV2. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Build a human-readable Telegram message from the notification payload. */
export function renderTelegramMessage(payload: NotificationPayload): string {
  const e = escapeMarkdownV2;
  const durationSec = Math.round(payload.durationMs / 1000);

  // Header
  const lines: string[] = [
    `*Anatoly Audit Report*`,
    ``,
    `*Verdict:* ${e(payload.verdict)}`,
    `*Files:* ${e(String(payload.totalFiles))} total \\| ${e(String(payload.cleanFiles))} clean \\| ${e(String(payload.findingFiles))} findings \\| ${e(String(payload.errorFiles))} errors`,
    `*Cost:* \\$${e(payload.costUsd.toFixed(2))}`,
    `*Duration:* ${e(String(durationSec))}s`,
    ``,
    `*Axis Scorecard:*`,
  ];

  // Axis scorecard
  for (const [axis, counts] of Object.entries(payload.axisScorecard)) {
    const total = counts.high + counts.medium + counts.low;
    if (total === 0) continue;
    lines.push(`  ${e(axis)}: ${e(String(counts.high))}H ${e(String(counts.medium))}M ${e(String(counts.low))}L`);
  }

  // Top findings — build incrementally, respecting the limit
  const findingsHeader = `\n*Top Findings:*`;
  const reportUrlLine = payload.reportUrl
    ? `\n[Full report](${payload.reportUrl})`
    : '';

  // Reserve space for header, URL line, and a potential (+N more) line
  const reservedChars = findingsHeader.length + reportUrlLine.length + 30;
  let bodyText = lines.join('\n');
  const budget = TELEGRAM_MAX_LENGTH - bodyText.length - reservedChars;

  const findingLines: string[] = [];
  let usedChars = 0;
  let includedCount = 0;

  for (const finding of payload.topFindings) {
    const line = `  \\- ${e(finding.file)}: ${e(finding.detail)}`;
    if (usedChars + line.length + 1 > budget) break;
    findingLines.push(line);
    usedChars += line.length + 1;
    includedCount++;
  }

  const remaining = payload.topFindings.length - includedCount;
  if (remaining > 0) {
    findingLines.push(`  ${e(`(+${remaining} more)`)}`);
  }

  // Assemble final message
  let message = bodyText;
  if (findingLines.length > 0) {
    message += findingsHeader + '\n' + findingLines.join('\n');
  }
  if (reportUrlLine) {
    message += reportUrlLine;
  }

  // Final safety truncation (should not trigger with the budget logic above)
  if (message.length > TELEGRAM_MAX_LENGTH) {
    message = message.slice(0, TELEGRAM_MAX_LENGTH - 3) + '\\.\\.\\.';
  }

  return message;
}

/**
 * Sends audit report summaries to a Telegram channel via the Bot API.
 * Uses native `fetch()` (Node 20+) — zero npm dependencies.
 */
export class TelegramNotifier implements NotificationChannel {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  async send(payload: NotificationPayload): Promise<void> {
    const text = renderTelegramMessage(payload);
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'MarkdownV2',
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const desc = (body as Record<string, unknown>).description ?? response.status;
      throw new Error(`Telegram API error: ${desc}`);
    }
  }
}
