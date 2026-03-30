// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramNotifier, renderTelegramMessage, escapeMarkdownV2 } from './telegram.js';
import type { NotificationPayload } from './index.js';

const basePayload: NotificationPayload = {
  verdict: 'NEEDS_REFACTOR',
  totalFiles: 42,
  cleanFiles: 30,
  findingFiles: 10,
  errorFiles: 2,
  durationMs: 120000,
  costUsd: 1.23,
  axisScorecard: {
    dead: { high: 3, medium: 5, low: 0 },
    duplicate: { high: 1, medium: 2, low: 0 },
    overengineering: { high: 0, medium: 2, low: 0 },
    correction: { high: 1, medium: 0, low: 0 },
    tests: { high: 0, medium: 0, low: 0 },
    documentation: { high: 0, medium: 0, low: 0 },
    best_practices: { high: 0, medium: 1, low: 0 },
  },
  topFindings: [
    { file: 'src/core/scanner.ts', axis: 'correction', severity: 'high', detail: 'Null dereference on line 42' },
    { file: 'src/utils/cache.ts', axis: 'dead', severity: 'high', detail: 'Function buildKey is never imported' },
    { file: 'src/rag/indexer.ts', axis: 'dead', severity: 'high', detail: 'Function createIndex is never imported' },
  ],
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
    // Verdict is escaped for MarkdownV2
    expect(msg).toContain('NEEDS\\_REFACTOR');
    expect(msg).toContain('42');
    expect(msg).toContain('1\\.23');
  });

  it('should include axis scorecard', () => {
    const msg = renderTelegramMessage(basePayload);
    expect(msg).toContain('dead');
    expect(msg).toContain('correction');
  });

  it('should include top findings', () => {
    const msg = renderTelegramMessage(basePayload);
    expect(msg).toContain('scanner');
    expect(msg).toContain('Null dereference');
  });

  it('should append report URL when provided', () => {
    const msg = renderTelegramMessage({ ...basePayload, reportUrl: 'https://example.com/report' });
    expect(msg).toContain('https://example.com/report');
  });

  it('should not include report URL when absent', () => {
    const msg = renderTelegramMessage(basePayload);
    expect(msg).not.toContain('Full report');
  });

  it('should respect the 4096 character limit', () => {
    const manyFindings = Array.from({ length: 50 }, (_, i) => ({
      file: `src/module-${i}/very-long-file-name-to-fill-space.ts`,
      axis: 'correction' as const,
      severity: 'high' as const,
      detail: `Finding ${i}: Very long description that should contribute to exceeding the character limit when many findings are present`,
    }));
    const largePayload: NotificationPayload = { ...basePayload, topFindings: manyFindings };
    const msg = renderTelegramMessage(largePayload);
    expect(msg.length).toBeLessThanOrEqual(4096);
  });

  it('should add (+N more) indicator when findings are truncated', () => {
    const manyFindings = Array.from({ length: 80 }, (_, i) => ({
      file: `src/module-${i}/very-long-path/deeply-nested-directory/component.ts`,
      axis: 'correction' as const,
      severity: 'high' as const,
      detail: `Finding ${i}: This is a detailed description of the issue that adds significant character length to each finding entry in the message`,
    }));
    const largePayload: NotificationPayload = { ...basePayload, topFindings: manyFindings };
    const msg = renderTelegramMessage(largePayload);
    expect(msg).toMatch(/\+\d+ more/);
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

  it('should POST to the correct Telegram API URL', async () => {
    const notifier = new TelegramNotifier('test-token', '-100123');
    await notifier.send(basePayload);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
  });

  it('should send with parse_mode MarkdownV2', async () => {
    const notifier = new TelegramNotifier('test-token', '-100123');
    await notifier.send(basePayload);
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.parse_mode).toBe('MarkdownV2');
    expect(body.chat_id).toBe('-100123');
    expect(body.text).toBeTruthy();
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
