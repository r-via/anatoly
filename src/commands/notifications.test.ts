// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { patchNotificationsConfig, upsertEnvVar } from './notifications.js';

// The commented first-run template, byte-for-byte as setup-prompts.ts emits it
// (sectionHeader + commentedYaml of the notifications block), wrapped by the
// next section so the block boundary is exercised.
const COMMENTED_TEMPLATE = [
  '# ---- notifications (optional) ----------------------------------------------',
  '# notifications:',
  '#   telegram:',
  '#     enabled: true',
  '#     username: YourTelegramUsername',
  '#     bot_token_env: ANATOLY_TELEGRAM_BOT_TOKEN',
  '',
  '# ---- badge (optional) ------------------------------------------------------',
  '# badge:',
  '#   enabled: true',
  '',
].join('\n');

// The corrupted state the old writer produced (reported by a user): the
// `# notifications:` header stayed commented while the body got uncommented,
// and the original commented children (incl. `bot_token_env`) lingered below.
const CORRUPTED = [
  '# ---- notifications (optional) ----------------------------------------------',
  '# notifications:',
  '  telegram:',
  '    enabled: true',
  '    username: "calibrae"',
  '',
  '#   telegram:',
  '#     enabled: true',
  '#     username: YourTelegramUsername',
  '#     bot_token_env: ANATOLY_TELEGRAM_BOT_TOKEN',
  '',
  '# ---- badge (optional) ------------------------------------------------------',
  '# badge:',
  '#   enabled: true',
  '',
].join('\n');

function parsedTelegram(content: string): Record<string, unknown> | undefined {
  const doc = yaml.load(content) as { notifications?: { telegram?: Record<string, unknown> } };
  return doc?.notifications?.telegram;
}

describe('patchNotificationsConfig', () => {
  it('returns a standalone active block when there is no existing config', () => {
    const out = patchNotificationsConfig(null, 'calibrae');
    expect(parsedTelegram(out)).toEqual({
      enabled: true,
      username: 'calibrae',
      bot_token_env: 'ANATOLY_TELEGRAM_BOT_TOKEN',
    });
  });

  it('uncomments the first-run template into a working active block', () => {
    const out = patchNotificationsConfig(COMMENTED_TEMPLATE, 'calibrae');
    expect(parsedTelegram(out)).toEqual({
      enabled: true,
      username: 'calibrae',
      bot_token_env: 'ANATOLY_TELEGRAM_BOT_TOKEN',
    });
    // The bot_token_env line is now ACTIVE, not a lingering comment.
    expect(out).toContain('    bot_token_env: ANATOLY_TELEGRAM_BOT_TOKEN');
    expect(out).not.toContain('#     bot_token_env');
    expect(out).not.toContain('# notifications:');
    // Neighbouring section is left intact.
    expect(out).toContain('# ---- badge');
    expect(out).toContain('# badge:');
  });

  it('repairs the corrupted half-decommented state into one valid block', () => {
    const out = patchNotificationsConfig(CORRUPTED, 'calibrae');
    // Exactly one active notifications block, valid YAML, bot_token_env present.
    expect(parsedTelegram(out)).toEqual({
      enabled: true,
      username: 'calibrae',
      bot_token_env: 'ANATOLY_TELEGRAM_BOT_TOKEN',
    });
    expect(out).not.toContain('# notifications:');
    expect(out).not.toContain('#     bot_token_env');
    // Only one `telegram:` key remains (no duplicate-key leftover).
    expect(out.match(/^\s*telegram:/gm)?.length).toBe(1);
    expect(out).toContain('# ---- badge');
  });

  it('replaces an already-active block in place (overwrite path)', () => {
    const existing = [
      '# ---- notifications (optional) ----',
      'notifications:',
      '  telegram:',
      '    enabled: true',
      '    username: "old_name"',
      '    bot_token_env: ANATOLY_TELEGRAM_BOT_TOKEN',
      '',
      '# ---- badge (optional) ----',
      '# badge:',
      '',
    ].join('\n');
    const out = patchNotificationsConfig(existing, 'new_name');
    expect(parsedTelegram(out)?.username).toBe('new_name');
    expect(out).not.toContain('old_name');
    expect(out.match(/^notifications:/gm)?.length).toBe(1);
    expect(out).toContain('# ---- badge');
  });

  it('appends a block when an unrelated config has no notifications section', () => {
    const existing = 'version: 3\nconcurrency: 8\n';
    const out = patchNotificationsConfig(existing, 'calibrae');
    const doc = yaml.load(out) as Record<string, unknown>;
    expect(doc.version).toBe(3);
    expect(parsedTelegram(out)?.enabled).toBe(true);
  });
});

describe('upsertEnvVar', () => {
  it('creates the file content when none exists', () => {
    expect(upsertEnvVar(null, 'ANATOLY_TELEGRAM_BOT_TOKEN', '123:ABC')).toBe(
      'ANATOLY_TELEGRAM_BOT_TOKEN=123:ABC\n',
    );
  });

  it('replaces an existing active assignment', () => {
    const env = 'FOO=bar\nANATOLY_TELEGRAM_BOT_TOKEN=old\nBAZ=qux\n';
    const out = upsertEnvVar(env, 'ANATOLY_TELEGRAM_BOT_TOKEN', '123:ABC');
    expect(out).toContain('ANATOLY_TELEGRAM_BOT_TOKEN=123:ABC');
    expect(out).not.toContain('=old');
    expect(out).toContain('FOO=bar');
    expect(out).toContain('BAZ=qux');
  });

  it('appends when only a commented placeholder is present (the dropped-token bug)', () => {
    const env = '# ANATOLY_TELEGRAM_BOT_TOKEN=changeme\nFOO=bar\n';
    const out = upsertEnvVar(env, 'ANATOLY_TELEGRAM_BOT_TOKEN', '123:ABC');
    // The commented placeholder is left untouched...
    expect(out).toContain('# ANATOLY_TELEGRAM_BOT_TOKEN=changeme');
    // ...and a real active assignment is added.
    expect(out).toMatch(/^ANATOLY_TELEGRAM_BOT_TOKEN=123:ABC$/m);
  });

  it('appends with a newline separator when the file lacks a trailing newline', () => {
    const out = upsertEnvVar('FOO=bar', 'ANATOLY_TELEGRAM_BOT_TOKEN', '123:ABC');
    expect(out).toBe('FOO=bar\nANATOLY_TELEGRAM_BOT_TOKEN=123:ABC\n');
  });
});
