// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LLM_CALLS_SCHEMA_VERSION,
  getActiveSinkPath,
  getActiveSinkTotals,
  recordLlmCall,
  withLlmCallSink,
} from './llm-calls-sink.js';
import { runWithContext } from './log-context.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anatoly-sink-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readEvents(path: string): unknown[] {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('llm-calls-sink', () => {
  it('writes one ndjson line per recordLlmCall with schemaVersion + t offset', () => {
    const path = join(dir, 'llm-calls.ndjson');
    withLlmCallSink(path, () => {
      recordLlmCall({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: 0.01, durationMs: 500,
        success: true,
      });
    });

    const events = readEvents(path);
    expect(events).toHaveLength(1);
    const e = events[0] as Record<string, unknown>;
    expect(e.schemaVersion).toBe(LLM_CALLS_SCHEMA_VERSION);
    expect(typeof e.t).toBe('number');
    expect(e.t).toBeGreaterThanOrEqual(0);
    expect(e.provider).toBe('anthropic');
    expect(e.inputTokens).toBe(100);
  });

  it('appends multiple calls in order on a single line each', () => {
    const path = join(dir, 'llm-calls.ndjson');
    withLlmCallSink(path, () => {
      for (let i = 0; i < 3; i++) {
        recordLlmCall({
          provider: 'anthropic', model: 'm', inputTokens: i, outputTokens: 0,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0, durationMs: 0, success: true,
        });
      }
    });

    const events = readEvents(path);
    expect(events.map((e) => (e as { inputTokens: number }).inputTokens)).toEqual([0, 1, 2]);
  });

  it('inherits phase and axis from the active log context (no need to pass them explicitly)', () => {
    const path = join(dir, 'llm-calls.ndjson');
    withLlmCallSink(path, () => {
      runWithContext({ phase: 'review', axis: 'correction' }, () => {
        recordLlmCall({
          provider: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0, durationMs: 0, success: true,
        });
      });
    });

    const e = readEvents(path)[0] as Record<string, unknown>;
    expect(e.phase).toBe('review');
    expect(e.axis).toBe('correction');
  });

  it('omits phase/axis when no log context is active', () => {
    const path = join(dir, 'llm-calls.ndjson');
    withLlmCallSink(path, () => {
      recordLlmCall({
        provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: 0, durationMs: 0, success: true,
      });
    });

    const e = readEvents(path)[0] as Record<string, unknown>;
    expect('phase' in e).toBe(false);
    expect('axis' in e).toBe(false);
  });

  it('is a silent no-op when called outside any sink scope', () => {
    const path = join(dir, 'never-created.ndjson');
    // No withLlmCallSink wrapper — should not throw, should not create the file.
    expect(() =>
      recordLlmCall({
        provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: 0, durationMs: 0, success: true,
      }),
    ).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('persists error metadata for failed calls', () => {
    const path = join(dir, 'llm-calls.ndjson');
    withLlmCallSink(path, () => {
      recordLlmCall({
        provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: 0, durationMs: 0, success: false,
        attempt: 2,
        retryReason: 'rate_limit',
        error: { code: 'RATE_LIMIT', message: '429' },
      });
    });

    const e = readEvents(path)[0] as Record<string, unknown>;
    expect(e.success).toBe(false);
    expect(e.attempt).toBe(2);
    expect(e.error).toEqual({ code: 'RATE_LIMIT', message: '429' });
  });

  it('exposes the active sink path via getActiveSinkPath()', () => {
    const path = join(dir, 'llm-calls.ndjson');
    expect(getActiveSinkPath()).toBeUndefined();
    withLlmCallSink(path, () => {
      expect(getActiveSinkPath()).toBe(path);
    });
    expect(getActiveSinkPath()).toBeUndefined();
  });

  describe('getActiveSinkTotals', () => {
    it('returns undefined outside any sink scope', () => {
      expect(getActiveSinkTotals()).toBeUndefined();
    });

    it('starts at zero and accumulates each recordLlmCall', () => {
      const path = join(dir, 'llm-calls.ndjson');
      withLlmCallSink(path, () => {
        expect(getActiveSinkTotals()).toEqual({
          calls: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
        });

        recordLlmCall({
          provider: 'anthropic', model: 'm',
          inputTokens: 100, outputTokens: 50,
          cacheReadTokens: 200, cacheCreationTokens: 5,
          costUsd: 0.01, durationMs: 100, success: true,
        });
        recordLlmCall({
          provider: 'anthropic', model: 'm',
          inputTokens: 30, outputTokens: 10,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0.002, durationMs: 50, success: true,
        });

        expect(getActiveSinkTotals()).toEqual({
          calls: 2,
          inputTokens: 130,
          outputTokens: 60,
          cacheReadTokens: 200,
          cacheCreationTokens: 5,
          costUsd: 0.012,
        });
      });
    });

    it('returns a snapshot that is decoupled from later mutations', () => {
      const path = join(dir, 'llm-calls.ndjson');
      withLlmCallSink(path, () => {
        recordLlmCall({
          provider: 'a', model: 'm', inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0, durationMs: 0, success: true,
        });
        const snapshot = getActiveSinkTotals();
        recordLlmCall({
          provider: 'a', model: 'm', inputTokens: 99, outputTokens: 99,
          cacheReadTokens: 0, cacheCreationTokens: 0,
          costUsd: 0, durationMs: 0, success: true,
        });
        expect(snapshot?.inputTokens).toBe(1);
        expect(getActiveSinkTotals()?.inputTokens).toBe(100);
      });
    });
  });
});
