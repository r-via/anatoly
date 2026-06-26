// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../utils/config-loader.js';
import { resolveUsernameToChatId } from '../core/notifications/index.js';
import { escapeMarkdownV2 } from '../core/notifications/telegram.js';

function isCancelled(value: unknown): value is symbol {
  return p.isCancel(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Upsert a `KEY=value` assignment in `.env` file content.
 *
 * Replaces an existing *active* assignment (tolerating leading whitespace) and
 * otherwise appends one. A plain `content.includes(key)` check is deliberately
 * avoided: it also matches a commented placeholder (`# KEY=...`), after which
 * the anchored replace silently no-ops and the value is never written — the
 * reported "bot token never inserted" symptom.
 *
 * @param content current file content, or null/empty when the file is absent.
 */
export function upsertEnvVar(content: string | null, key: string, value: string): string {
  const line = `${key}=${value}`;
  if (!content) return `${line}\n`;
  // Active assignment only: a leading `#` (commented) must NOT match, so we
  // anchor on optional spaces/tabs then the key, never a hash.
  const assignmentRe = new RegExp(`^[ \\t]*${escapeRegExp(key)}=.*$`, 'm');
  if (assignmentRe.test(content)) return content.replace(assignmentRe, line);
  return content.endsWith('\n') ? `${content}${line}\n` : `${content}\n${line}\n`;
}

/**
 * Insert or repair the `notifications.telegram` block in `.anatoly.yml` content.
 *
 * Handles every state of the existing config:
 *  - an active `notifications:` block → replaced in place;
 *  - the commented first-run template (`# notifications:` + `#   ...` children)
 *    → replaced with an active block;
 *  - none → appended.
 *
 * Matching the commented form is essential. The previous writer keyed off a
 * bare `includes('notifications:')` (true for the commented template) and a
 * mid-line regex that left the `# ` prefix on the header while uncommenting the
 * body, producing invalid YAML (`# notifications:` above an uncommented
 * `  telegram:`). The loader then never saw `telegram.enabled`, so the setup
 * hint re-prompted on every run. The block regex below matches the header in
 * either form plus its body (indented YAML and/or `#   ...` children), so it
 * also repairs that corrupted half-decommented state.
 *
 * @param content current file content, or null/empty when the file is absent.
 */
export function patchNotificationsConfig(
  content: string | null,
  username: string,
  botTokenEnv = 'ANATOLY_TELEGRAM_BOT_TOKEN',
): string {
  const block =
    `notifications:\n`
    + `  telegram:\n`
    + `    enabled: true\n`
    + `    username: "${username}"\n`
    + `    bot_token_env: ${botTokenEnv}\n`;
  if (!content) return block;
  // Body = the header line plus following indented YAML lines, deeply-commented
  // (`#   ...`) children, and blank lines — bounded by the next top-level key or
  // a `# ---- section ----` header (which has a single space after `#`, so it is
  // never mistaken for a `#   ` child needing >=2). Consuming the blanks and the
  // leftover commented children also cleans up the corrupted half-decommented
  // template in the same pass, so the stale `#   bot_token_env: ...` line does
  // not linger beside the new active block.
  const blockRe =
    /^[ \t]*#?[ \t]*notifications:[^\n]*\n(?:[ \t]+[^\n]*\n|[ \t]*#[ \t]{2,}[^\n]*\n|[ \t]*\n)*/m;
  if (blockRe.test(content)) {
    // Re-add one blank line after the block to keep section separation, then
    // collapse any trailing blank run at EOF back to a single newline.
    return content.replace(blockRe, `${block}\n`).replace(/\n{2,}$/, '\n');
  }
  return `${content.replace(/\s*$/, '')}\n\n${block}`;
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

/**
 * Interactive Telegram bot setup. Verifies a bot token, configures the bot
 * identity, writes the token to `.env`, waits for the user's `/start`, and
 * sends a welcome message.
 *
 * @param projectRoot project root for `.env` / `.anatoly.yml`.
 * @param opts.writeConfig when true (standalone `anatoly init --notifications`
 *        path, existing config), patch `.anatoly.yml`'s `notifications`
 *        block in place. When false (advanced-init phase, config not written
 *        yet), skip the yaml write and return `{ username }` for the wizard
 *        to fold into the generated config.
 * @returns `{ username }` on success, `null` if the user cancels or setup
 *          can't complete (composes inside a wizard without killing the
 *          process).
 */
export async function runTelegramSetup(
  projectRoot: string,
  opts: { writeConfig: boolean },
): Promise<{ username: string } | null> {
      // Guard: when patching an existing config, warn if already set.
      if (opts.writeConfig) {
        const existingConfig = loadConfig(projectRoot);
        const existingTelegram = existingConfig.notifications?.telegram;
        if (existingTelegram?.enabled && (existingTelegram.chat_id || existingTelegram.username)) {
          const target = existingTelegram.username ? `@${existingTelegram.username}` : `chat_id ${existingTelegram.chat_id}`;
          p.log.warn(`Telegram notifications are already configured for ${target}.`);
          const overwrite = await p.confirm({
            message: 'Overwrite existing configuration?',
            initialValue: false,
          });
          if (isCancelled(overwrite) || !overwrite) {
            p.cancel('Existing configuration preserved.');
            return null;
          }
        }
      }

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
          if (!value?.includes(':')) return 'Invalid format. Expected something like 123456:ABC-DEF...';
        },
      });
      if (isCancelled(token)) { p.cancel('Setup cancelled.'); return null; }

      // Verify token
      const verifySpinner = p.spinner();
      verifySpinner.start('Verifying token...');

      const meResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      if (!meResponse.ok) {
        verifySpinner.stop('Invalid token');
        p.cancel('Token verification failed. Check with @BotFather.');
        return null;
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

      // Step 2: Save token to .env (upsert: replace an active assignment, else
      // append — never silently skip on a commented placeholder).
      const envPath = resolve(projectRoot, '.env');
      const envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : null;
      writeFileSync(envPath, upsertEnvVar(envContent, 'ANATOLY_TELEGRAM_BOT_TOKEN', token));
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
        placeholder: 'your_username',
        validate: (value) => {
          if (!value) return 'Username is required';
        },
      });
      if (isCancelled(username)) { p.cancel('Setup cancelled.'); return null; }

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
        return null;
      }
      waitSpinner.stop(`Found @${username} (chat_id: ${chatId})`);

      // Step 5: Patch .anatoly.yml — only when operating on an existing
      // config (standalone `init --notifications`). In the advanced-init
      // flow the config isn't written yet; the wizard folds `{ username }`
      // into the generated yaml instead.
      if (opts.writeConfig) {
        const configPath = resolve(projectRoot, '.anatoly.yml');
        const configContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
        writeFileSync(configPath, patchNotificationsConfig(configContent, username));
        p.log.success('.anatoly.yml updated');
      }

      // Step 6: Send logo + welcome message
      const welcomeSpinner = p.spinner();
      welcomeSpinner.start('Sending welcome message...');
      try {
        // Send the logo first
        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            photo: `https://raw.githubusercontent.com/r-via/anatoly/main/assets/imgs/banner_telegram.jpg?v=${Date.now()}`,
            caption: '🧹✨ *Anatoly is in the building\\!*',
            parse_mode: 'MarkdownV2',
          }),
        });

        const welcomeText =
          `🎉 *Houston, we have liftoff\\!*\n\n` +
          // Escape the raw username: an unescaped '_' (e.g. john_doe) is a
          // MarkdownV2 italic delimiter and makes Telegram reject the send (400).
          `Comms are live for *@${escapeMarkdownV2(username)}* 📡\n\n` +
          `After every \\\`anatoly run\\\`, I'll beam you:\n` +
          `  🔍 The verdict \\— CLEAN, NEEDS\\_REFACTOR, or CRITICAL\n` +
          `  📊 Health bars for all 7 axes\n` +
          `  🔴 Top findings at a glance\n` +
          `  💰 Cost \\& duration\n\n` +
          `You're all set\\. Go break some code, I'll watch\\. 🫡`;

        const welcomeResp = await botApi('sendMessage', {
          chat_id: chatId,
          text: welcomeText,
          parse_mode: 'MarkdownV2',
        });
        // fetch() does not throw on 4xx; without this check a rejected send
        // (e.g. a MarkdownV2 parse error) would still report success.
        if (welcomeResp.ok) {
          welcomeSpinner.stop('Welcome message sent! 🚀');
        } else {
          welcomeSpinner.stop(`Welcome message not sent (Telegram returned ${welcomeResp.status}).`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        welcomeSpinner.stop(`Failed: ${msg}`);
      }

      p.note(
        `Other team members just need to:\n` +
        `1. Send /start to @${botUsername}\n` +
        `2. Set their username in .anatoly.yml`,
        '👥 Team onboarding',
      );

      if (opts.writeConfig) p.outro('🧹 Setup complete — Anatoly is watching.');
      return { username };
}

/** Registers the `notifications` CLI parent command (test subcommand only;
 *  bot setup is `anatoly init --notifications`). */
export function registerNotificationsCommand(parent: Command): void {
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

      p.intro('🧪 Notification test');

      const sendSpinner = p.spinner();
      sendSpinner.start('Pinging Telegram...');
      try {
        const testMessage =
          `🧹 *Houston, do you copy\\?*\n\n` +
          `This is Anatoly\\. Comms check\\.\n\n` +
          `📡 Signal strength: ▓▓▓▓▓ *5/5*\n` +
          `✅ Bot token: valid\n` +
          `✅ Chat ID: resolved\n` +
          `✅ Delivery: confirmed\n\n` +
          `_Roger that\\. Standing by for the next audit run\\. 🫡_`;

        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: testMessage,
            parse_mode: 'MarkdownV2',
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as Record<string, unknown>;
          throw new Error(String(body.description ?? response.status));
        }

        sendSpinner.stop('Message received! 🎉');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendSpinner.stop(`Failed: ${msg}`);
        process.exitCode = 1;
      }
      p.outro('📡 Loud and clear.');
    });
}
