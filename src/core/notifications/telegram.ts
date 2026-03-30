// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { NotificationChannel, NotificationPayload } from './index.js';

const TELEGRAM_MAX_LENGTH = 4096;

/** Escape special characters for Telegram MarkdownV2. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Verdict → emoji mapping. */
function verdictEmoji(verdict: string): string {
  if (verdict === 'CLEAN') return '✅';
  if (verdict === 'CRITICAL') return '🔴';
  return '🟡'; // NEEDS_REFACTOR
}

/** Axis display names (telegram-friendly, no special chars). */
const AXIS_DISPLAY: Record<string, string> = {
  correction: '🐛 Correction',
  dead: '♻️ Utility',
  duplicate: '📋 Duplication',
  overengineering: '🏗️ Overeng',
  tests: '🧪 Tests',
  documentation: '📝 Docs',
  best_practices: '✅ Best Practices',
};

/**
 * Build an emoji health bar matching the public report style.
 * 10 squares, color by pct + high-finding density.
 */
function healthBar(pct: number, highFindings = 0, totalFiles = 0): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const density = totalFiles > 0 ? highFindings / totalFiles : highFindings > 0 ? 1 : 0;
  let square: string;
  if (density >= 0.15) {
    square = '🟥';
  } else if (density >= 0.03) {
    square = pct >= 50 ? '🟨' : '🟥';
  } else if (density > 0) {
    square = pct >= 95 ? '🟩' : pct >= 50 ? '🟨' : '🟥';
  } else {
    square = pct >= 80 ? '🟩' : pct >= 50 ? '🟨' : '🟥';
  }
  return square.repeat(filled) + '⬜'.repeat(10 - filled);
}

/** Build a human-readable Telegram message from the notification payload. */
export function renderTelegramMessage(payload: NotificationPayload): string {
  const e = escapeMarkdownV2;
  const durationMin = Math.round(payload.durationMs / 60_000);
  const totalFindings = Object.values(payload.axisScorecard).reduce((sum, c) => sum + c.high + c.medium + c.low, 0);

  // ── Hero block ──
  const lines: string[] = [
    `${verdictEmoji(payload.verdict)} *Anatoly Audit*`,
    ``,
    `*${e(String(payload.totalFiles))}* files · *${e(String(totalFindings))}* findings · *${e(String(payload.findingFiles))}* files affected`,
    `${e(String(durationMin))} min · \\$${e(payload.costUsd.toFixed(2))}`,
    ``,
  ];

  // ── Axis scorecard with health bars ──
  for (const [axis, counts] of Object.entries(payload.axisScorecard)) {
    const total = counts.high + counts.medium + counts.low;
    const pct = counts.healthPct;
    const name = AXIS_DISPLAY[axis] ?? e(axis);
    const bar = healthBar(Math.max(0, Math.min(100, pct)), counts.high, payload.totalFiles);
    const label = counts.label ? ` ${e(counts.label)}` : '';

    if (total === 0) {
      lines.push(`${name}  ${bar} ${e(String(pct))}%${label}`);
    } else {
      const parts: string[] = [];
      if (counts.high > 0) parts.push(`${counts.high}H`);
      if (counts.medium > 0) parts.push(`${counts.medium}M`);
      lines.push(`${name}  ${bar} ${e(String(pct))}%${label}  ${e(parts.join(' '))}`);
    }
  }

  // ── Top findings (file + axis, grouped per axis) ──
  if (payload.topFindings.length > 0) {
    lines.push(``);
    lines.push(`*Top findings:*`);

    // Group by axis, preserve order
    const byAxis = new Map<string, typeof payload.topFindings>();
    for (const f of payload.topFindings) {
      const list = byAxis.get(f.axis) ?? [];
      list.push(f);
      byAxis.set(f.axis, list);
    }

    const axisEmojis: Record<string, string> = {
      correction: '🐛', dead: '♻️', duplicate: '📋',
      overengineering: '🏗️', tests: '🧪', documentation: '📝',
      best_practices: '✅',
    };

    for (const [axis, findings] of byAxis) {
      const emoji = axisEmojis[axis] ?? '•';
      for (const f of findings) {
        const sev = f.severity === 'HIGH' ? '🔴' : '🟡';
        lines.push(`${sev} ${emoji} \`${e(f.file)}\``);
      }
    }
  }

  // ── Footer ──
  lines.push(``);
  if (payload.reportUrl) {
    lines.push(`📄 [Full report](${payload.reportUrl.replace(/[)\\]/g, '\\$&')})`);
  } else {
    lines.push(`_See the full report on the machine that ran the audit\\._`);
  }

  let message = lines.join('\n');

  // Safety truncation
  if (message.length > TELEGRAM_MAX_LENGTH) {
    const cutPoint = message.lastIndexOf('\n', TELEGRAM_MAX_LENGTH - 6);
    message = message.slice(0, cutPoint > 0 ? cutPoint : TELEGRAM_MAX_LENGTH - 6) + '\\.\\.\\.';
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
