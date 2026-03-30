// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
  evaluated: number;
  cached: number;
  cleanFiles: number;
  findingFiles: number;
  errorFiles: number;
  durationMs: number;
  costUsd: number;
  totalTokens: number;
  axisScorecard: Record<string, { high: number; medium: number; low: number; healthPct: number; label: string }>;
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

/** Cache file for resolved username → chat_id mappings. */
function chatIdCachePath(projectRoot: string): string {
  return resolve(projectRoot, '.anatoly', 'telegram-chat-ids.json');
}

type ChatIdCache = Record<string, string>;

function loadChatIdCache(projectRoot: string): ChatIdCache {
  const cachePath = chatIdCachePath(projectRoot);
  if (!existsSync(cachePath)) return {};
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as ChatIdCache;
  } catch {
    return {};
  }
}

function saveChatIdCache(projectRoot: string, cache: ChatIdCache): void {
  const cachePath = chatIdCachePath(projectRoot);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

/**
 * Resolve a Telegram username to a chat_id by scanning the bot's recent updates.
 * The user must have sent at least one message (e.g. /start) to the bot.
 * Resolved IDs are cached in `.anatoly/telegram-chat-ids.json`.
 */
export async function resolveUsernameToChatId(
  botToken: string,
  username: string,
  projectRoot: string,
): Promise<string | null> {
  const normalizedUsername = username.replace(/^@/, '').toLowerCase();

  // Check cache first
  const cache = loadChatIdCache(projectRoot);
  if (cache[normalizedUsername]) return cache[normalizedUsername];

  // Query bot updates
  const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const data = await response.json() as {
    ok: boolean;
    result: Array<{ message?: { from?: { username?: string }; chat?: { id: number } } }>;
  };

  if (!data.ok) return null;

  for (const update of data.result) {
    const from = update.message?.from;
    const chat = update.message?.chat;
    if (from?.username?.toLowerCase() === normalizedUsername && chat?.id) {
      const chatId = String(chat.id);
      cache[normalizedUsername] = chatId;
      saveChatIdCache(projectRoot, cache);
      return chatId;
    }
  }

  return null;
}

/**
 * Dispatch notifications to all enabled channels.
 * Fire-and-forget: errors are logged as warnings, never thrown.
 */
export async function sendNotifications(config: Config, payload: NotificationPayload, projectRoot?: string): Promise<void> {
  const telegram = config.notifications?.telegram;
  if (!telegram?.enabled) return;

  const tokenEnv = telegram.bot_token_env ?? 'ANATOLY_TELEGRAM_BOT_TOKEN';
  const botToken = process.env[tokenEnv];

  if (!botToken) {
    console.warn(`Telegram bot token not found in env (${tokenEnv})`);
    return;
  }

  // Resolve chat_id: explicit > cached username resolution
  let chatId = telegram.chat_id;
  if (!chatId && telegram.username) {
    const root = projectRoot ?? process.cwd();
    chatId = await resolveUsernameToChatId(botToken, telegram.username, root) ?? undefined;
    if (!chatId) {
      console.warn(`Could not resolve Telegram username @${telegram.username}. Send /start to the bot first.`);
      return;
    }
  }

  if (!chatId) {
    console.warn('No chat_id or username configured for Telegram notifications');
    return;
  }

  try {
    const notifier = new TelegramNotifier(botToken, chatId);
    await notifier.send(payload);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Telegram notification failed: ${msg}`);
  }
}
