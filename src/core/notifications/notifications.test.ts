// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigSchema } from '../../schemas/config.js';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    warn: warnSpy,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  }),
}));

const { sendNotifications } = await import('./index.js');
type NotificationPayload = Parameters<typeof sendNotifications>[1];

const basePayload: NotificationPayload = {
  projectName: 'test-project',
  verdict: 'CLEAN',
  totalFiles: 10,
  evaluated: 10,
  cached: 0,
  cleanFiles: 10,
  findingFiles: 0,
  errorFiles: 0,
  durationMs: 5000,
  costUsd: 0.5,
  totalTokens: 50_000,
  axisScorecard: {},
};

describe('sendNotifications', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalEnv = process.env;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    process.env = { ...originalEnv };
    warnSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it('should skip silently when config.notifications is undefined', async () => {
    const config = ConfigSchema.parse({});
    await sendNotifications(config, basePayload);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip silently when telegram is not enabled', async () => {
    const config = ConfigSchema.parse({
      notifications: { telegram: { enabled: false } },
    });
    await sendNotifications(config, basePayload);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should send notification when telegram is enabled and token exists', async () => {
    process.env.ANATOLY_TELEGRAM_BOT_TOKEN = 'test-token-123';
    const config = ConfigSchema.parse({
      notifications: { telegram: { enabled: true, chat_id: '-100123' } },
    });
    await sendNotifications(config, basePayload);
    expect(fetchMock).toHaveBeenCalledOnce(); // single photo+caption
  });

  it('should warn and skip when bot token env var is missing', async () => {
    delete process.env.ANATOLY_TELEGRAM_BOT_TOKEN;
    const config = ConfigSchema.parse({
      notifications: { telegram: { enabled: true, chat_id: '-100123' } },
    });
    await sendNotifications(config, basePayload);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bot token'));
  });

  it('should warn and skip when bot token env var is empty', async () => {
    process.env.ANATOLY_TELEGRAM_BOT_TOKEN = '';
    const config = ConfigSchema.parse({
      notifications: { telegram: { enabled: true, chat_id: '-100123' } },
    });
    await sendNotifications(config, basePayload);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('should warn but not crash when Telegram API errors', async () => {
    process.env.ANATOLY_TELEGRAM_BOT_TOKEN = 'test-token';
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    });
    const config = ConfigSchema.parse({
      notifications: { telegram: { enabled: true, chat_id: '-100123' } },
    });
    // Should NOT throw — fire-and-forget with warning
    await sendNotifications(config, basePayload);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Telegram'));
  });

  it('should warn but not crash on network failure', async () => {
    process.env.ANATOLY_TELEGRAM_BOT_TOKEN = 'test-token';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const config = ConfigSchema.parse({
      notifications: { telegram: { enabled: true, chat_id: '-100123' } },
    });
    await sendNotifications(config, basePayload);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('should use custom bot_token_env when specified', async () => {
    process.env.MY_CUSTOM_TOKEN = 'custom-token';
    const config = ConfigSchema.parse({
      notifications: { telegram: { enabled: true, chat_id: '-100123', bot_token_env: 'MY_CUSTOM_TOKEN' } },
    });
    await sendNotifications(config, basePayload);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('custom-token');
  });
});
