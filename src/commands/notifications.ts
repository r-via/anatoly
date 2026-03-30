// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { loadConfig } from '../utils/config-loader.js';
import { sendNotifications, resolveUsernameToChatId, type NotificationPayload } from '../core/notifications/index.js';

const TEST_PAYLOAD: NotificationPayload = {
  verdict: 'NEEDS_REFACTOR',
  totalFiles: 42,
  cleanFiles: 35,
  findingFiles: 5,
  errorFiles: 2,
  durationMs: 123_456,
  costUsd: 0.87,
  axisScorecard: {
    correction: { high: 1, medium: 3, low: 0 },
    utility: { high: 0, medium: 2, low: 1 },
    tests: { high: 0, medium: 1, low: 4 },
  },
  topFindings: [
    { file: 'src/core/example.ts', axis: 'correction', severity: 'HIGH', detail: 'Unhandled promise rejection in async handler' },
    { file: 'src/utils/helpers.ts', axis: 'utility', severity: 'MEDIUM', detail: 'Function exportedButNeverImported is dead code' },
    { file: 'src/commands/run.ts', axis: 'tests', severity: 'MEDIUM', detail: 'No test coverage for error branch' },
  ],
};

function isCancelled(value: unknown): value is symbol {
  return p.isCancel(value);
}

async function waitForBotMessage(botToken: string, username: string, maxAttempts = 30): Promise<string | null> {
  const normalized = username.replace(/^@/, '').toLowerCase();
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
    if (response.ok) {
      const data = await response.json() as {
        ok: boolean;
        result: Array<{ message?: { from?: { username?: string }; chat?: { id: number } } }>;
      };
      for (const update of data.result) {
        if (update.message?.from?.username?.toLowerCase() === normalized && update.message?.chat?.id) {
          return String(update.message.chat.id);
        }
      }
    }
    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

/** Registers the `notifications` CLI parent command with subcommands. */
export function registerNotificationsCommand(parent: Command): void {
  // --- create-bot ---
  parent
    .command('create-bot')
    .description('Interactive setup: create a Telegram bot and configure notifications')
    .action(async () => {
      const projectRoot = resolve('.');

      p.intro('Telegram Bot Setup');

      // Step 1: Create bot
      p.note(
        '1. Open Telegram and search for @BotFather\n' +
        '2. Send /newbot\n' +
        '3. Choose a name (e.g. "Anatoly Audit")\n' +
        '4. Choose a username (e.g. anatoly_audit_bot)\n' +
        '5. Copy the token BotFather gives you',
        'Step 1 — Create a Telegram bot',
      );

      const token = await p.text({
        message: 'Paste the bot token here',
        placeholder: '123456:ABC-DEF...',
        validate: (value) => {
          if (!value.includes(':')) return 'Invalid format. Expected something like 123456:ABC-DEF...';
        },
      });
      if (isCancelled(token)) { p.cancel('Setup cancelled.'); process.exit(0); }

      // Verify token
      const verifySpinner = p.spinner();
      verifySpinner.start('Verifying token...');

      const meResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      if (!meResponse.ok) {
        verifySpinner.stop('Invalid token');
        p.cancel('Token verification failed. Check with @BotFather.');
        process.exit(1);
      }
      const meData = await meResponse.json() as { result: { username: string } };
      const botUsername = meData.result.username;
      verifySpinner.stop(`Bot verified: @${botUsername}`);

      // Configure bot identity
      const configSpinner = p.spinner();
      configSpinner.start('Configuring bot identity...');

      const botApi = (method: string, body: Record<string, string>) =>
        fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      await Promise.all([
        botApi('setMyName', { name: 'Anatoly Audit' }),
        botApi('setMyDescription', {
          description:
            'Anatoly is an autonomous AI audit agent for codebases. ' +
            'This bot sends you a summary after each audit run — verdict, findings, cost, and a link to the full report.\n\n' +
            'Send /start to activate notifications, then add your Telegram username to .anatoly.yml.',
        }),
        botApi('setMyShortDescription', {
          short_description: 'AI code audit notifications — deep, evidence-backed findings from Anatoly.',
        }),
      ]);

      configSpinner.stop('Bot identity configured (name, description)');

      p.log.info('Set the bot profile photo manually:');
      p.log.info('  Send /setuserpic to @BotFather, select your bot, and upload the logo.');

      // Step 2: Save token to .env
      const envPath = resolve(projectRoot, '.env');
      const envLine = `ANATOLY_TELEGRAM_BOT_TOKEN=${token}`;
      if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf-8');
        if (envContent.includes('ANATOLY_TELEGRAM_BOT_TOKEN')) {
          const updated = envContent.replace(/^ANATOLY_TELEGRAM_BOT_TOKEN=.*$/m, envLine);
          writeFileSync(envPath, updated);
        } else {
          appendFileSync(envPath, `\n${envLine}\n`);
        }
      } else {
        writeFileSync(envPath, `${envLine}\n`);
      }
      p.log.success('Token saved to .env');

      // Warn if .env not gitignored
      const gitignorePath = resolve(projectRoot, '.gitignore');
      if (existsSync(gitignorePath)) {
        const gitignore = readFileSync(gitignorePath, 'utf-8');
        if (!gitignore.includes('.env')) {
          p.log.warn('.env is not in .gitignore — add it to avoid leaking the token');
        }
      }

      // Step 3: Get username
      const username = await p.text({
        message: 'Your Telegram username (without @)',
        placeholder: 'LeetPunk',
        validate: (value) => {
          if (!value) return 'Username is required';
        },
      });
      if (isCancelled(username)) { p.cancel('Setup cancelled.'); process.exit(0); }

      // Step 4: User sends /start
      p.note(
        `Open this link and send /start:\n\nhttps://t.me/${botUsername}`,
        'Step 4 — Activate the bot',
      );

      await p.text({
        message: 'Press Enter when done',
        defaultValue: '',
      });

      // Wait for the message
      const waitSpinner = p.spinner();
      waitSpinner.start(`Waiting for @${username} to message the bot...`);
      process.env.ANATOLY_TELEGRAM_BOT_TOKEN = token;
      const chatId = await waitForBotMessage(token, username);

      if (!chatId) {
        waitSpinner.stop('Not found');
        p.cancel(`Could not detect a message from @${username}. Try sending /start again.`);
        process.exit(1);
      }
      waitSpinner.stop(`Found @${username} (chat_id: ${chatId})`);

      // Step 5: Update .anatoly.yml
      const configPath = resolve(projectRoot, '.anatoly.yml');
      if (existsSync(configPath)) {
        let configContent = readFileSync(configPath, 'utf-8');
        if (configContent.includes('notifications:')) {
          configContent = configContent.replace(
            /notifications:[\s\S]*?(?=\n\S|\n*$)/,
            `notifications:\n  telegram:\n    enabled: true\n    username: "${username}"\n`,
          );
        } else {
          configContent += `\nnotifications:\n  telegram:\n    enabled: true\n    username: "${username}"\n`;
        }
        writeFileSync(configPath, configContent);
      } else {
        writeFileSync(configPath, `notifications:\n  telegram:\n    enabled: true\n    username: "${username}"\n`);
      }
      p.log.success('.anatoly.yml updated');

      // Step 6: Send welcome message
      const welcomeSpinner = p.spinner();
      welcomeSpinner.start('Sending welcome message...');
      try {
        const welcomeText =
          `*Welcome to Anatoly* 🧹\n\n` +
          `Notifications are now active for *@${username}*\\.\n\n` +
          `After each \\`anatoly run\\`, you'll receive:\n` +
          `  \\- Audit verdict \\(CLEAN / NEEDS\\_REFACTOR / CRITICAL\\)\n` +
          `  \\- File stats and cost summary\n` +
          `  \\- Axis scorecard with finding counts\n` +
          `  \\- Top findings with severity\n\n` +
          `Run \\`anatoly notifications test\\` anytime to verify\\.`;

        await botApi('sendMessage', {
          chat_id: chatId,
          text: welcomeText,
          parse_mode: 'MarkdownV2',
        });
        welcomeSpinner.stop('Welcome message sent!');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        welcomeSpinner.stop(`Failed: ${msg}`);
      }

      p.note(
        `Other team members just need to:\n` +
        `1. Send /start to @${botUsername}\n` +
        `2. Set their username in .anatoly.yml`,
        'Team onboarding',
      );

      p.outro('Setup complete');
    });

  // --- test ---
  parent
    .command('test')
    .description('Send a test notification to verify your configuration')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = parent.parent!.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      const telegram = config.notifications?.telegram;
      if (!telegram?.enabled) {
        p.log.error('Telegram notifications are not enabled in .anatoly.yml');
        p.note(
          'notifications:\n  telegram:\n    enabled: true\n    username: "YourTelegramUsername"',
          'Add this to your config',
        );
        process.exitCode = 1;
        return;
      }

      const tokenEnv = telegram.bot_token_env ?? 'ANATOLY_TELEGRAM_BOT_TOKEN';
      const botToken = process.env[tokenEnv];
      if (!botToken) {
        p.log.error(`Bot token not found in environment variable: ${tokenEnv}`);
        process.exitCode = 1;
        return;
      }

      // Resolve chat_id from username if needed
      let chatId = telegram.chat_id;
      if (!chatId && telegram.username) {
        const resolveSpinner = p.spinner();
        resolveSpinner.start(`Resolving @${telegram.username}...`);
        chatId = await resolveUsernameToChatId(botToken, telegram.username, projectRoot) ?? undefined;
        if (!chatId) {
          resolveSpinner.stop('Not found');
          p.log.error(`Could not resolve @${telegram.username}. Send /start to the bot first.`);
          process.exitCode = 1;
          return;
        }
        resolveSpinner.stop(`Resolved: ${chatId} (cached)`);
      }

      if (!chatId) {
        p.log.error('No chat_id or username configured');
        process.exitCode = 1;
        return;
      }

      p.intro('Notification test');
      p.log.info(`Channel:   Telegram`);
      if (telegram.username) p.log.info(`Username:  @${telegram.username}`);
      p.log.info(`Chat ID:   ${chatId}`);

      const payload: NotificationPayload = {
        ...TEST_PAYLOAD,
        reportUrl: telegram.report_url ?? undefined,
      };

      const sendSpinner = p.spinner();
      sendSpinner.start('Sending test notification...');
      try {
        await sendNotifications(config, payload, projectRoot);
        sendSpinner.stop('Test notification sent successfully');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendSpinner.stop(`Failed: ${msg}`);
        process.exitCode = 1;
      }
      p.outro('Done');
    });
}
