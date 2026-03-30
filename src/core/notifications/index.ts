// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Config } from '../../schemas/config.js';
import type { Verdict } from '../../schemas/review.js';
import { TelegramNotifier } from './telegram.js';

/**
 * Payload passed to every notification channel after a run completes.
 * Built from {@link ReportData} + {@link RunStats} in the pipeline.
 */
export interface NotificationPayload {
  verdict: Verdict;
  totalFiles: number;
  cleanFiles: number;
  findingFiles: number;
  errorFiles: number;
  durationMs: number;
  costUsd: number;
  axisScorecard: Record<string, { high: number; medium: number; low: number }>;
  topFindings: Array<{ file: string; axis: string; severity: string; detail: string }>;
  reportUrl?: string;
}

/**
 * Generic notification channel interface.
 * Implement `send()` to add a new channel (Slack, Discord, webhook, etc.).
 */
export interface NotificationChannel {
  send(payload: NotificationPayload): Promise<void>;
}

/**
 * Dispatch notifications to all enabled channels.
 * Fire-and-forget: errors are logged as warnings, never thrown.
 */
export async function sendNotifications(config: Config, payload: NotificationPayload): Promise<void> {
  const telegram = config.notifications?.telegram;
  if (!telegram?.enabled) return;

  const tokenEnv = telegram.bot_token_env ?? 'ANATOLY_TELEGRAM_BOT_TOKEN';
  const botToken = process.env[tokenEnv];

  if (!botToken) {
    console.warn(`Telegram bot token not found in env (${tokenEnv})`);
    return;
  }

  try {
    const notifier = new TelegramNotifier(botToken, telegram.chat_id!);
    await notifier.send(payload);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Telegram notification failed: ${msg}`);
  }
}
