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

/** Short axis names to avoid line wrapping on mobile. */
const AXIS_LABEL: Record<string, string> = {
  correction: '🐛 Bugs',
  dead: '♻️ Dead',
  utility: '♻️ Dead',
  duplicate: '📋 Dups',
  duplication: '📋 Dups',
  overengineering: '🏗️ Over',
  tests: '🧪 Tests',
  documentation: '📝 Docs',
  best_practices: '✅ BP',
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
  const SEP = '━━━━━━━━━━━━━━━━━━━━';

  // ── Hero ──
  const lines: string[] = [
    `${verdictEmoji(payload.verdict)} *${e(payload.verdict)}* — Anatoly`,
    ``,
    `${e(String(payload.totalFiles))} files reviewed · \\$${e(payload.costUsd.toFixed(2))} · ${e(String(durationMin))} min`,
    `*${e(String(totalFindings))}* findings in *${e(String(payload.findingFiles))}* files`,
  ];

  // ── Scorecard ── sorted worst-first, compact lines
  lines.push(``);
  lines.push(SEP);
  lines.push(``);

  const entries = Object.entries(payload.axisScorecard)
    .map(([axis, c]) => ({ axis, ...c, pct: c.healthPct ?? 0 }))
    .sort((a, b) => a.pct - b.pct);

  for (const { axis, pct, high, low } of entries) {
    const label = AXIS_LABEL[axis] ?? e(axis);
    const bar = healthBar(Math.max(0, Math.min(100, pct)), high, payload.totalFiles);
    // Pad label to 8 chars for alignment (emoji counts as ~2)
    lines.push(`${label}  ${bar}  ${e(String(pct))}%`);
  }

  // ── Finding summary by severity ──
  const totalHigh = Object.values(payload.axisScorecard).reduce((s, c) => s + c.high, 0);
  const totalMed = Object.values(payload.axisScorecard).reduce((s, c) => s + c.medium, 0);

  if (totalHigh > 0 || totalMed > 0) {
    lines.push(``);
    lines.push(SEP);
    lines.push(``);

    // Per-axis high counts on one line
    if (totalHigh > 0) {
      const highParts: string[] = [];
      for (const { axis, high } of entries) {
        if (high > 0) {
          const name = AXIS_LABEL[axis]?.replace(/^.\S*\s/, '') ?? axis;
          highParts.push(`${high} ${e(name.toLowerCase())}`);
        }
      }
      lines.push(`🔴 ${e(String(totalHigh))} high — ${highParts.join(' · ')}`);
    }

    if (totalMed > 0) {
      const medParts: string[] = [];
      for (const { axis, medium } of entries) {
        if (medium > 0) {
          const name = AXIS_LABEL[axis]?.replace(/^.\S*\s/, '') ?? axis;
          medParts.push(`${medium} ${e(name.toLowerCase())}`);
        }
      }
      lines.push(`🟡 ${e(String(totalMed))} med — ${medParts.join(' · ')}`);
    }
  }

  // ── Footer ──
  lines.push(``);
  lines.push(SEP);
  lines.push(``);
  if (payload.reportUrl) {
    lines.push(`📄 [Full report](${payload.reportUrl.replace(/[)\\]/g, '\\$&')})`);
  } else {
    lines.push(`_Full report on the machine that ran the audit_`);
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
