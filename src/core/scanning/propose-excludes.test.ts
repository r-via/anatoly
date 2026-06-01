// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { proposeExcludes, ProposeExcludesResponseSchema, type ExcludeSuggestion } from './propose-excludes.js';
import { runSingleTurnQuery } from '../evaluation/index.js';
import type { Config } from '../../schemas/config.js';
import type { TransportRouter } from '../transports/index.js';

const cfg = {
  models: { deliberation: 'anthropic/claude-opus-4-6', quality: 'anthropic/claude-sonnet-4-6' },
  runtime: { timeout_per_call: 120 },
} as unknown as Config;

const router = {} as TransportRouter;

/** Build a queryFn stub that returns canned excludes without touching an LLM. */
function stubQuery(excludes: ExcludeSuggestion[]): typeof runSingleTurnQuery {
  return (async () => ({
    data: { excludes },
    costUsd: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    transcript: '',
  })) as unknown as typeof runSingleTurnQuery;
}

const files = ['src/app.ts', 'src/__fixtures__/dead.ts', 'src/generated/api.ts'];

describe('proposeExcludes', () => {
  it('returns [] on an empty file list without calling the model', async () => {
    const throwing = (() => { throw new Error('should not be called'); }) as unknown as typeof runSingleTurnQuery;
    expect(await proposeExcludes({ projectRoot: '/x', config: cfg, router, files: [], queryFn: throwing })).toEqual([]);
  });

  it('returns the model-proposed suggestions', async () => {
    const out = await proposeExcludes({
      projectRoot: '/x', config: cfg, router, files,
      queryFn: stubQuery([
        { glob: 'src/__fixtures__/**', category: 'fixture', reason: 'dead sample code' },
        { glob: '**/generated/**', category: 'generated', reason: 'codegen output' },
      ]),
    });
    expect(out.map((s) => s.glob)).toEqual(['src/__fixtures__/**', '**/generated/**']);
    expect(out[0].category).toBe('fixture');
  });

  it('drops globs already excluded', async () => {
    const out = await proposeExcludes({
      projectRoot: '/x', config: cfg, router, files,
      alreadyExcluded: ['src/__fixtures__/**'],
      queryFn: stubQuery([
        { glob: 'src/__fixtures__/**', category: 'fixture', reason: 'already there' },
        { glob: '**/generated/**', category: 'generated', reason: 'new' },
      ]),
    });
    expect(out.map((s) => s.glob)).toEqual(['**/generated/**']);
  });

  it('threads conversationDir + callId into the query params', async () => {
    let captured: { conversationDir?: string; callId?: string } | undefined;
    const capturing = ((params: { conversationDir?: string; callId?: string }) => {
      captured = params;
      return Promise.resolve({
        data: { excludes: [] }, costUsd: 0, durationMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, transcript: '',
      });
    }) as unknown as typeof runSingleTurnQuery;
    await proposeExcludes({
      projectRoot: '/x', config: cfg, router, files,
      conversationDir: '/x/.anatoly/commands/scope/ts/conversations',
      queryFn: capturing,
    });
    expect(captured?.conversationDir).toBe('/x/.anatoly/commands/scope/ts/conversations');
    expect(captured?.callId).toBe('propose-excludes');
  });

  it('dedupes repeated globs within the response', async () => {
    const out = await proposeExcludes({
      projectRoot: '/x', config: cfg, router, files,
      queryFn: stubQuery([
        { glob: '**/generated/**', category: 'generated', reason: 'a' },
        { glob: '**/generated/**', category: 'generated', reason: 'b' },
      ]),
    });
    expect(out).toHaveLength(1);
  });
});

describe('ProposeExcludesResponseSchema', () => {
  it('accepts a well-formed response', () => {
    const r = ProposeExcludesResponseSchema.safeParse({ excludes: [{ glob: 'a/**', category: 'fixture', reason: 'x' }] });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown category', () => {
    const r = ProposeExcludesResponseSchema.safeParse({ excludes: [{ glob: 'a/**', category: 'nope', reason: 'x' }] });
    expect(r.success).toBe(false);
  });

  it('accepts an empty list', () => {
    expect(ProposeExcludesResponseSchema.safeParse({ excludes: [] }).success).toBe(true);
  });
});
