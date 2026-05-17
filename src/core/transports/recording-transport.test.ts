// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LlmTransport, LlmRequest, LlmResponse, AgenticRequest } from './index.js';
import { RecordingTransport, maybeWrapTransport } from './recording-transport.js';

function res(text: string): LlmResponse {
  return {
    text,
    costUsd: 0.01,
    durationMs: 100,
    inputTokens: 500,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    transcript: `transcript:${text}`,
  };
}

/** Fake inner transport with a call counter and an optional explode mode. */
class FakeTransport implements LlmTransport {
  readonly provider = 'anthropic';
  queryCalls = 0;
  agenticCalls = 0;
  explode = false;

  supports(_model: string): boolean {
    return true;
  }

  async query(params: LlmRequest): Promise<LlmResponse> {
    if (this.explode) throw new Error('inner.query MUST NOT be called in replay');
    this.queryCalls++;
    return res(`q:${params.userMessage}`);
  }

  async agenticQuery(params: AgenticRequest): Promise<LlmResponse> {
    if (this.explode) throw new Error('inner.agenticQuery MUST NOT be called in replay');
    this.agenticCalls++;
    return res(`a:${params.userMessage}`);
  }
}

function req(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    systemPrompt: 'you are a reviewer',
    userMessage: 'review this',
    model: 'anthropic/claude-sonnet-4-6',
    projectRoot: '/tmp/proj-a',
    abortController: new AbortController(),
    ...overrides,
  };
}

function agentReq(overrides: Partial<AgenticRequest> = {}): AgenticRequest {
  return {
    ...req(),
    allowedTools: ['Read'],
    config: {} as AgenticRequest['config'],
    ...overrides,
  };
}

let dir: string;
let cassette: string;
const SAVED = {
  mode: process.env.ANATOLY_TRANSPORT,
  path: process.env.ANATOLY_TRANSPORT_CASSETTE,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rec-transport-'));
  cassette = join(dir, 'cassette.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (SAVED.mode === undefined) delete process.env.ANATOLY_TRANSPORT;
  else process.env.ANATOLY_TRANSPORT = SAVED.mode;
  if (SAVED.path === undefined) delete process.env.ANATOLY_TRANSPORT_CASSETTE;
  else process.env.ANATOLY_TRANSPORT_CASSETTE = SAVED.path;
});

describe('maybeWrapTransport', () => {
  it('is the identity function when ANATOLY_TRANSPORT is unset (production)', () => {
    delete process.env.ANATOLY_TRANSPORT;
    const inner = new FakeTransport();
    expect(maybeWrapTransport(inner)).toBe(inner);
  });

  it('wraps when ANATOLY_TRANSPORT is set', () => {
    process.env.ANATOLY_TRANSPORT = 'replay';
    process.env.ANATOLY_TRANSPORT_CASSETTE = cassette;
    const inner = new FakeTransport();
    expect(maybeWrapTransport(inner)).not.toBe(inner);
  });

  it('throws if mode is set but cassette path is missing', () => {
    process.env.ANATOLY_TRANSPORT = 'record';
    delete process.env.ANATOLY_TRANSPORT_CASSETTE;
    expect(() => maybeWrapTransport(new FakeTransport())).toThrow(/ANATOLY_TRANSPORT_CASSETTE/);
  });
});

describe('RecordingTransport record then replay', () => {
  it('record delegates to inner and persists the cassette', async () => {
    const inner = new FakeTransport();
    const rec = new RecordingTransport(inner, { mode: 'record', cassettePath: cassette });

    const out = await rec.query(req({ userMessage: 'hello' }));

    expect(out.text).toBe('q:hello');
    expect(inner.queryCalls).toBe(1);
    expect(existsSync(cassette)).toBe(true);
    const parsed = JSON.parse(readFileSync(cassette, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.entries)).toHaveLength(1);
  });

  it('replay serves the recorded response and never calls inner', async () => {
    const recInner = new FakeTransport();
    const rec = new RecordingTransport(recInner, { mode: 'record', cassettePath: cassette });
    await rec.query(req({ userMessage: 'hello' }));
    await rec.agenticQuery(agentReq({ userMessage: 'agent-hello' }));

    const replayInner = new FakeTransport();
    replayInner.explode = true; // any inner call is a test failure
    const replay = new RecordingTransport(replayInner, { mode: 'replay', cassettePath: cassette });

    const q = await replay.query(req({ userMessage: 'hello' }));
    const a = await replay.agenticQuery(agentReq({ userMessage: 'agent-hello' }));

    expect(q.text).toBe('q:hello');
    expect(a.text).toBe('a:agent-hello');
    expect(replayInner.queryCalls).toBe(0);
    expect(replayInner.agenticCalls).toBe(0);
  });

  it('replay throws a loud, debuggable error on a cassette miss', async () => {
    const replay = new RecordingTransport(new FakeTransport(), {
      mode: 'replay',
      cassettePath: cassette,
    });
    await expect(replay.query(req({ userMessage: 'never recorded' }))).rejects.toThrow(
      /cassette miss/,
    );
  });
});

describe('key determinism', () => {
  it('replays across a different projectRoot when the path is embedded in the prompt', async () => {
    const rootA = '/tmp/proj-aaaa';
    const rootB = '/tmp/proj-bbbb';
    const recInner = new FakeTransport();
    const rec = new RecordingTransport(recInner, { mode: 'record', cassettePath: cassette });
    await rec.query(
      req({ projectRoot: rootA, userMessage: `file at ${rootA}/src/x.ts`, systemPrompt: `root ${rootA}` }),
    );

    const replayInner = new FakeTransport();
    replayInner.explode = true;
    const replay = new RecordingTransport(replayInner, { mode: 'replay', cassettePath: cassette });

    // Same logical request, different temp root: must hit the same key.
    const out = await replay.query(
      req({ projectRoot: rootB, userMessage: `file at ${rootB}/src/x.ts`, systemPrompt: `root ${rootB}` }),
    );
    expect(out.text).toContain('file at');
    expect(replayInner.queryCalls).toBe(0);
  });

  it('masks ISO timestamps and long epoch digit runs', async () => {
    const recInner = new FakeTransport();
    const rec = new RecordingTransport(recInner, { mode: 'record', cassettePath: cassette });
    await rec.query(req({ userMessage: 'shard tier3-shard-1747461011586 at 2026-05-17T08:50:11.586Z' }));

    const replayInner = new FakeTransport();
    replayInner.explode = true;
    const replay = new RecordingTransport(replayInner, { mode: 'replay', cassettePath: cassette });
    // Different epoch + timestamp, same logical request.
    const out = await replay.query(
      req({ userMessage: 'shard tier3-shard-9999999999999 at 2030-01-01T00:00:00.000Z' }),
    );
    expect(out.text).toBeTruthy();
    expect(replayInner.queryCalls).toBe(0);
  });

  it('different semantic requests get different keys', async () => {
    const inner = new FakeTransport();
    const rec = new RecordingTransport(inner, { mode: 'record', cassettePath: cassette });
    await rec.query(req({ userMessage: 'review file A' }));
    await rec.query(req({ userMessage: 'review file B' }));
    const parsed = JSON.parse(readFileSync(cassette, 'utf8'));
    expect(Object.keys(parsed.entries)).toHaveLength(2);
  });
});

describe('delegation', () => {
  it('delegates provider and supports to the wrapped transport', () => {
    const inner = new FakeTransport();
    const rec = new RecordingTransport(inner, { mode: 'replay', cassettePath: cassette });
    expect(rec.provider).toBe('anthropic');
    expect(rec.supports('any-model')).toBe(true);
  });
});
