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

/** Axis display names. */
const AXIS_NAME: Record<string, string> = {
  correction: 'Correction', dead: 'Utility', utility: 'Utility',
  duplicate: 'Duplication', duplication: 'Duplication', overengineering: 'Overengineering',
  tests: 'Tests', documentation: 'Documentation', best_practices: 'Best Practices',
};

/** Axis emoji for scorecard lines. */
const AXIS_EMOJI: Record<string, string> = {
  correction: '🐛', dead: '♻️', utility: '♻️',
  duplicate: '📋', duplication: '📋', overengineering: '🏗️',
  tests: '🧪', documentation: '📝', best_practices: '✅',
};

/**
 * Build a compact 5-block emoji health bar for mobile.
 * Color by pct + high-finding density (same logic as public report).
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

  // ── Intro ──
  const intros: Record<string, string[]> = {
    CLEAN: [
      '🧹 Houston, the codebase is *spotless*\\. Nothing to report\\.',
      '🧹 All clear\\. Anatoly swept every corner — not a speck\\.',
      '🧹 Mission complete\\. Zero findings\\. Go grab a coffee\\. ☕',
    ],
    NEEDS_REFACTOR: [
      '🧹 Anatoly found a few things under the rug\\.',
      '🧹 Not bad, but Anatoly left some sticky notes\\.',
      '🧹 Almost clean\\. A few spots need another pass\\.',
    ],
    CRITICAL: [
      '🚨 Anatoly found something nasty\\. You might want to sit down\\.',
      '🚨 Houston, we have a problem\\.',
      '🚨 Code red\\. Anatoly is not amused\\.',
    ],
  };
  const pool = intros[payload.verdict] ?? intros.NEEDS_REFACTOR;
  const intro = pool[Math.floor(Math.random() * pool.length)];

  // ── Hero ──
  const lines: string[] = [
    intro,
    ``,
    `${verdictEmoji(payload.verdict)} *${e(payload.verdict)}* — Anatoly`,
    ``,
    `${e(String(payload.totalFiles))} files reviewed · \\$${e(payload.costUsd.toFixed(2))} · ${e(String(durationMin))} min`,
    `*${e(String(totalFindings))}* findings in *${e(String(payload.findingFiles))}* files`,
    ``,
    SEP,
    ``,
  ];

  // ── Scorecard ── sorted worst-first
  const entries = Object.entries(payload.axisScorecard)
    .map(([axis, c]) => ({ axis, ...c, pct: c.healthPct ?? 0 }))
    .sort((a, b) => a.pct - b.pct);

  for (const { axis, pct, high, medium } of entries) {
    const emoji = AXIS_EMOJI[axis] ?? '•';
    const name = AXIS_NAME[axis] ?? axis;
    const bar = healthBar(Math.max(0, Math.min(100, pct)), high, payload.totalFiles);
    const total = high + medium;
    const counts = total > 0
      ? `  ${[high > 0 ? `${high}H` : '', medium > 0 ? `${medium}M` : ''].filter(Boolean).join(' ')}`
      : '';
    lines.push(`${emoji} *${e(name)}*${e(counts)}`);
    lines.push(`${bar} ${e(String(pct))}%`);
    lines.push(``);
  }

  // ── Top findings ──
  if (payload.topFindings.length > 0) {
    lines.push(``);
    lines.push(SEP);
    lines.push(``);
    lines.push(`*Top findings:*`);

    for (const f of payload.topFindings) {
      const sev = f.severity.toUpperCase() === 'HIGH' ? '🔴' : '🟡';
      const emoji = AXIS_EMOJI[f.axis] ?? '•';
      lines.push(`${sev} ${emoji} \`${e(f.file)}\``);
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
