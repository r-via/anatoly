// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as evaluation from '../../evaluation/index.js';
import { refreshPendingConflicts, buildRefreshUserMessage } from './doc-conflict-refresh.js';
import type { DocConflict } from '../../../schemas/doc-conflict.js';
import type { Config } from '../../../schemas/config.js';
import type { TransportRouter } from '../../transports/index.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'doc-conflict-refresh-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeConfig(): Config {
  return {
    version: 2,
    project_name: 'test',
    project_root: tmp,
    models: { quality: 'anthropic/claude-sonnet-4-6', fast: 'anthropic/claude-haiku-4-5' },
    agents: { enabled: true, max_turns: 30 },
    runtime: { timeout_per_call: 600, max_retries: 3, concurrency: 8, min_confidence: 70, max_stop_iterations: 3 },
    axes: {},
    documentation: {
      reference: { paths: ['docs/**/*.md'] },
      internal: { mode: 'full' },
    },
  } as unknown as Config;
}

function makeEntry(overrides: Partial<DocConflict> = {}): DocConflict {
  return {
    id: 'entry-1',
    detected_at: '2026-05-01T00:00:00Z',
    anchor: {
      file: 'src/foo.ts',
      symbol: 'doThing',
      line_range: [1, 3],
      code_hash: 'deadbeef',
    },
    reference_excerpt: { path: 'docs/api.md', text: 'doThing accepts a string.' },
    code_summary: 'doThing accepts a Buffer.',
    signals: { presumption: 'doc-stale' },
    verdict: 'pending',
    status: 'active',
    ...overrides,
  };
}

function mockSingleTurn(responseJson: string): TransportRouter {
  vi.spyOn(evaluation, 'runSingleTurnQuery').mockImplementation(async () => ({
    data: JSON.parse(responseJson),
    costUsd: 0.001,
    durationMs: 50,
    inputTokens: 200,
    outputTokens: 30,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    transcript: '',
  }));
  return {} as TransportRouter;
}

function seedFile(rel: string, content: string): void {
  const full = join(tmp, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('refreshPendingConflicts — short-circuits', () => {
  it('returns unchanged with no pending entries', async () => {
    const entries = [makeEntry({ verdict: 'doc-wins', status: 'applied' })];
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router: {} as TransportRouter,
    });
    expect(result.summary.inspected).toBe(0);
    expect(result.entries).toEqual(entries);
  });

  it('skips when no router is provided', async () => {
    const entries = [makeEntry()];
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
    });
    expect(result.summary.inspected).toBe(1);
    expect(result.summary.stillPending).toBe(1);
    expect(result.entries[0].verdict).toBe('pending');
  });

  it('skips when no fast/quality model is configured', async () => {
    const config = { ...makeConfig(), models: {} } as unknown as Config;
    const entries = [makeEntry()];
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config,
      router: {} as TransportRouter,
    });
    expect(result.summary.stillPending).toBe(1);
    expect(result.entries[0].verdict).toBe('pending');
  });
});

describe('refreshPendingConflicts — verdict application', () => {
  it('applies high-confidence dismiss as dismiss + auto-resolved', async () => {
    seedFile('src/foo.ts', 'function doThing() {}\n');
    const entries = [makeEntry()];
    const router = mockSingleTurn(JSON.stringify({
      decisions: [{ id: 'entry-1', decision: 'dismiss', confidence: 0.95, note: 'golden-set fixture' }],
    }));
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router,
    });
    expect(result.entries[0].verdict).toBe('dismiss');
    expect(result.entries[0].status).toBe('auto-resolved');
    expect(result.entries[0].verdict_note).toContain('[auto-llm conf=0.95]');
    expect(result.entries[0].verdict_note).toContain('golden-set fixture');
    expect(result.summary.autoResolved.dismiss).toBe(1);
    expect(result.summary.stillPending).toBe(0);
  });

  it('applies high-confidence doc-wins', async () => {
    seedFile('src/foo.ts', 'function doThing() {}\n');
    const entries = [makeEntry()];
    const router = mockSingleTurn(JSON.stringify({
      decisions: [{ id: 'entry-1', decision: 'doc-wins', confidence: 0.9, note: 'doc is right' }],
    }));
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router,
    });
    expect(result.entries[0].verdict).toBe('doc-wins');
    expect(result.entries[0].status).toBe('auto-resolved');
    expect(result.summary.autoResolved.docWins).toBe(1);
  });

  it('applies high-confidence code-wins', async () => {
    seedFile('src/foo.ts', 'function doThing() {}\n');
    const entries = [makeEntry()];
    const router = mockSingleTurn(JSON.stringify({
      decisions: [{ id: 'entry-1', decision: 'code-wins', confidence: 0.88, note: 'code is right' }],
    }));
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router,
    });
    expect(result.entries[0].verdict).toBe('code-wins');
    expect(result.entries[0].status).toBe('auto-resolved');
    expect(result.summary.autoResolved.codeWins).toBe(1);
  });

  it('leaves entry pending when confidence is below threshold', async () => {
    seedFile('src/foo.ts', 'function doThing() {}\n');
    const entries = [makeEntry()];
    const router = mockSingleTurn(JSON.stringify({
      decisions: [{ id: 'entry-1', decision: 'dismiss', confidence: 0.5, note: 'unsure' }],
    }));
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router,
    });
    expect(result.entries[0].verdict).toBe('pending');
    expect(result.summary.belowConfidence).toBe(1);
    expect(result.summary.stillPending).toBe(1);
  });

  it('leaves entry pending on keep-pending decision regardless of confidence', async () => {
    seedFile('src/foo.ts', 'function doThing() {}\n');
    const entries = [makeEntry()];
    const router = mockSingleTurn(JSON.stringify({
      decisions: [{ id: 'entry-1', decision: 'keep-pending', confidence: 0.99, note: 'needs human' }],
    }));
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router,
    });
    expect(result.entries[0].verdict).toBe('pending');
    expect(result.summary.stillPending).toBe(1);
    expect(result.summary.belowConfidence).toBe(0);
  });

  it('honours a custom confidence threshold', async () => {
    seedFile('src/foo.ts', 'function doThing() {}\n');
    const entries = [makeEntry()];
    const router = mockSingleTurn(JSON.stringify({
      decisions: [{ id: 'entry-1', decision: 'dismiss', confidence: 0.72, note: 'cleared' }],
    }));
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router,
      confidenceThreshold: 0.7,
    });
    expect(result.entries[0].verdict).toBe('dismiss');
  });
});

describe('refreshPendingConflicts — context hydration', () => {
  it('marks missing files in the prompt context', async () => {
    const entries = [makeEntry({ anchor: { file: 'src/missing.ts', symbol: 'foo', code_hash: 'x' } })];
    let captured = '';
    vi.spyOn(evaluation, 'runSingleTurnQuery').mockImplementation(async (params) => {
      captured = params.userMessage;
      return {
        data: { decisions: [{ id: 'entry-1', decision: 'dismiss', confidence: 0.95, note: 'file gone' }] },
        costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, transcript: '',
      };
    });
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router: {} as TransportRouter,
    });
    expect(captured).toContain('<<FILE DELETED>>');
    expect(result.entries[0].verdict).toBe('dismiss');
  });

  it('extracts the line range from the current file', async () => {
    seedFile('src/foo.ts', ['line1', 'line2 TARGET', 'line3', 'line4'].join('\n'));
    const entries = [makeEntry({ anchor: { file: 'src/foo.ts', symbol: 'doThing', line_range: [2, 2], code_hash: 'x' } })];
    let captured = '';
    vi.spyOn(evaluation, 'runSingleTurnQuery').mockImplementation(async (params) => {
      captured = params.userMessage;
      return {
        data: { decisions: [{ id: 'entry-1', decision: 'keep-pending', confidence: 0.5, note: '' }] },
        costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, transcript: '',
      };
    });
    await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router: {} as TransportRouter,
    });
    expect(captured).toContain('line2 TARGET');
    expect(captured).not.toContain('line1');
    expect(captured).not.toContain('line4');
  });
});

describe('refreshPendingConflicts — batching and accounting', () => {
  it('chunks entries into batches and aggregates cost', async () => {
    seedFile('src/foo.ts', 'function doThing() {}\n');
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ id: `e-${i}` }));

    const router = {} as TransportRouter;
    let callCount = 0;
    vi.spyOn(evaluation, 'runSingleTurnQuery').mockImplementation(async (params) => {
      callCount++;
      const userIds = Array.from(params.userMessage.matchAll(/id=(e-\d+)/g), m => m[1]);
      return {
        data: { decisions: userIds.map(id => ({ id, decision: 'keep-pending', confidence: 0.5, note: '' })) },
        costUsd: 0.01,
        durationMs: 50,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        transcript: '',
      };
    });

    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router,
      batchSize: 2,
    });

    expect(callCount).toBe(3);
    expect(result.summary.cost?.calls).toBe(3);
    expect(result.summary.cost?.costUsd).toBeCloseTo(0.03);
  });

  it('reports errors for entries without a matching decision', async () => {
    seedFile('src/foo.ts', 'function doThing() {}\n');
    const entries = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })];
    const router = mockSingleTurn(JSON.stringify({
      decisions: [{ id: 'a', decision: 'dismiss', confidence: 0.95, note: 'ok' }],
    }));
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router,
    });
    expect(result.summary.autoResolved.dismiss).toBe(1);
    expect(result.summary.errors).toBe(1);
  });

  it('survives a per-batch query failure and continues', async () => {
    seedFile('src/foo.ts', 'function doThing() {}\n');
    const entries = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })];
    let n = 0;
    vi.spyOn(evaluation, 'runSingleTurnQuery').mockImplementation(async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return {
        data: { decisions: [{ id: 'b', decision: 'dismiss', confidence: 0.95, note: 'ok' }] },
        costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, transcript: '',
      };
    });
    const result = await refreshPendingConflicts(entries, {
      projectRoot: tmp,
      config: makeConfig(),
      router: {} as TransportRouter,
      batchSize: 1,
    });
    expect(result.summary.errors).toBeGreaterThanOrEqual(1);
    expect(result.summary.autoResolved.dismiss).toBe(1);
  });
});

describe('buildRefreshUserMessage', () => {
  it('includes anchor, reference excerpt, and current code per entry', () => {
    const entry = makeEntry();
    const msg = buildRefreshUserMessage([{ entry, currentCode: 'function doThing(s: string) {}' }]);
    expect(msg).toContain('id=entry-1');
    expect(msg).toContain('src/foo.ts::doThing');
    expect(msg).toContain('docs/api.md');
    expect(msg).toContain('doThing accepts a string.');
    expect(msg).toContain('function doThing(s: string) {}');
  });
});
