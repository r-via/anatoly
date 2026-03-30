// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramNotifier, renderTelegramMessage, escapeMarkdownV2 } from './telegram.js';
import type { NotificationPayload } from './index.js';

const basePayload: NotificationPayload = {
  projectName: 'test-project',
  verdict: 'NEEDS_REFACTOR',
  totalFiles: 42,
  evaluated: 42,
  cached: 0,
  cleanFiles: 30,
  findingFiles: 10,
  errorFiles: 2,
  durationMs: 120000,
  costUsd: 1.23,
  totalTokens: 1_250_000,
  axisScorecard: {
    dead: { high: 3, medium: 5, low: 0, healthPct: 86, label: 'used' },
    duplicate: { high: 1, medium: 2, low: 0, healthPct: 100, label: 'unique' },
    overengineering: { high: 0, medium: 2, low: 0, healthPct: 77, label: 'lean' },
    correction: { high: 1, medium: 0, low: 0, healthPct: 96, label: 'OK' },
    tests: { high: 0, medium: 0, low: 0, healthPct: 54, label: 'covered' },
    documentation: { high: 0, medium: 0, low: 0, healthPct: 82, label: 'documented' },
    best_practices: { high: 0, medium: 1, low: 0, healthPct: 80, label: 'avg 8.0 / 10' },
  },
};

describe('escapeMarkdownV2', () => {
  it('should escape all Telegram MarkdownV2 special characters', () => {
    expect(escapeMarkdownV2('a_b')).toBe('a\\_b');
    expect(escapeMarkdownV2('a!b')).toBe('a\\!b');
    expect(escapeMarkdownV2('(x)')).toBe('\\(x\\)');
    expect(escapeMarkdownV2('[x]')).toBe('\\[x\\]');
    expect(escapeMarkdownV2('{x}')).toBe('\\{x\\}');
    expect(escapeMarkdownV2('~x~')).toBe('\\~x\\~');
    expect(escapeMarkdownV2('`x`')).toBe('\\`x\\`');
    expect(escapeMarkdownV2('> x')).toBe('\\> x');
    expect(escapeMarkdownV2('# x')).toBe('\\# x');
    expect(escapeMarkdownV2('a+b')).toBe('a\\+b');
    expect(escapeMarkdownV2('a-b')).toBe('a\\-b');
    expect(escapeMarkdownV2('a=b')).toBe('a\\=b');
    expect(escapeMarkdownV2('a|b')).toBe('a\\|b');
    expect(escapeMarkdownV2('a.b')).toBe('a\\.b');
  });
});

describe('renderTelegramMessage', () => {
  it('should include verdict, files count, cost, and duration', () => {
    const msg = renderTelegramMessage(basePayload);
    expect(msg).toContain('🟡'); // NEEDS_REFACTOR verdict emoji
    expect(msg).toContain('NEEDS\\_REFACTOR'); // verdict text
    expect(msg).toContain('42 files reviewed');
    expect(msg).toContain('1\\.3M tokens'); // token count
    expect(msg).toContain('2 min'); // duration
  });

  it('should include scorecard with health bars sorted worst-first', () => {
    const msg = renderTelegramMessage(basePayload);
    expect(msg).toMatch(/🟩|🟨|🟥|⬜/); // emoji health bar
    expect(msg).toMatch(/%/); // percentages present
    // 54% (tests) should appear before 96% (correction) — worst first
    const idx54 = msg.indexOf('54%');
    const idx96 = msg.indexOf('96%');
    expect(idx54).toBeGreaterThan(-1);
    expect(idx96).toBeGreaterThan(-1);
    expect(idx54).toBeLessThan(idx96);
  });

  it('should include project name in header', () => {
    const msg = renderTelegramMessage(basePayload);
    expect(msg).toContain('test\\-project');
  });

  it('should append report URL when provided', () => {
    const msg = renderTelegramMessage({ ...basePayload, reportUrl: 'https://example.com/report' });
    expect(msg).toContain('https://example.com/report');
  });

  it('should show machine hint when URL absent', () => {
    const msg = renderTelegramMessage(basePayload);
    expect(msg).toContain('report\\.md');
  });

  it('should respect the 4096 character limit', () => {
    const largeScorecard: NotificationPayload['axisScorecard'] = {};
    for (let i = 0; i < 20; i++) {
      largeScorecard[`axis_${i}`] = { high: 100, medium: 200, low: 300, healthPct: 10, label: 'bad' };
    }
    const largePayload: NotificationPayload = { ...basePayload, axisScorecard: largeScorecard };
    const msg = renderTelegramMessage(largePayload);
    expect(msg.length).toBeLessThanOrEqual(4096);
  });
});

describe('TelegramNotifier', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send single photo+caption when message fits', async () => {
    const notifier = new TelegramNotifier('test-token', '-100123');
    await notifier.send(basePayload);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/sendPhoto');
    const body = JSON.parse(opts.body);
    expect(body.parse_mode).toBe('MarkdownV2');
    expect(body.caption).toBeTruthy();
    expect(body.chat_id).toBe('-100123');
  });

  it('should throw on HTTP error from Telegram API', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    });
    const notifier = new TelegramNotifier('bad-token', '-100123');
    await expect(notifier.send(basePayload)).rejects.toThrow('Telegram API error');
  });

  it('should throw on network error', async () => {
    fetchMock.mockRejectedValue(new Error('Network failure'));
    const notifier = new TelegramNotifier('test-token', '-100123');
    await expect(notifier.send(basePayload)).rejects.toThrow('Network failure');
  });
});
