// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { CacheFile } from './cache-meta.js';
import { computePromptHash, loadCacheWithMeta, writeCacheWithMeta } from './cache-meta.js';

// ---------------------------------------------------------------------------
// computePromptHash
// ---------------------------------------------------------------------------

describe('computePromptHash', () => {
  it('returns a string matching sha256:<64 hex chars>', () => {
    const hash = computePromptHash({
      schemaVersion: 1,
      modelId: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a code reviewer.',
      userTemplate: 'Review this file: {{file}}',
    });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs produce same hash', () => {
    const args = {
      schemaVersion: 1,
      modelId: 'claude-sonnet-4-20250514',
      systemPrompt: 'Hello',
      userTemplate: 'World',
    };
    expect(computePromptHash(args)).toBe(computePromptHash(args));
  });

  it('trailing whitespace in systemPrompt is normalised away', () => {
    const base = {
      schemaVersion: 1,
      modelId: 'model-a',
      userTemplate: 'tpl',
    };
    const a = computePromptHash({ ...base, systemPrompt: 'line one  \nline two\t\n' });
    const b = computePromptHash({ ...base, systemPrompt: 'line one\nline two\n' });
    expect(a).toBe(b);
  });

  it('trailing whitespace in userTemplate is normalised away', () => {
    const base = {
      schemaVersion: 1,
      modelId: 'model-a',
      systemPrompt: 'sys',
    };
    const a = computePromptHash({ ...base, userTemplate: 'hello   \nworld  ' });
    const b = computePromptHash({ ...base, userTemplate: 'hello\nworld' });
    expect(a).toBe(b);
  });

  it('CRLF and LF produce identical hashes (cross-platform)', () => {
    const base = {
      schemaVersion: 1,
      modelId: 'model-a',
      userTemplate: 'tpl',
    };
    const lf = computePromptHash({ ...base, systemPrompt: 'line one\nline two\n' });
    const crlf = computePromptHash({ ...base, systemPrompt: 'line one\r\nline two\r\n' });
    expect(crlf).toBe(lf);
  });

  it('CRLF in userTemplate is normalised to LF', () => {
    const base = {
      schemaVersion: 1,
      modelId: 'model-a',
      systemPrompt: 'sys',
    };
    const lf = computePromptHash({ ...base, userTemplate: 'a\nb' });
    const crlf = computePromptHash({ ...base, userTemplate: 'a\r\nb' });
    expect(crlf).toBe(lf);
  });

  it('trailing newlines are trimmed (no false cache bust)', () => {
    const base = {
      schemaVersion: 1,
      modelId: 'model-a',
      userTemplate: 'tpl',
    };
    const a = computePromptHash({ ...base, systemPrompt: 'hello world' });
    const b = computePromptHash({ ...base, systemPrompt: 'hello world\n' });
    const c = computePromptHash({ ...base, systemPrompt: 'hello world\n\n' });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('leading/trailing whitespace in templates is trimmed', () => {
    const base = {
      schemaVersion: 1,
      modelId: 'model-a',
      systemPrompt: 'sys',
    };
    const a = computePromptHash({ ...base, userTemplate: '  hello  ' });
    const b = computePromptHash({ ...base, userTemplate: 'hello' });
    expect(a).toBe(b);
  });

  it('semantic differences produce different hashes', () => {
    const base = {
      schemaVersion: 1,
      modelId: 'model-a',
      userTemplate: 'tpl',
    };
    const a = computePromptHash({ ...base, systemPrompt: 'Review carefully' });
    const b = computePromptHash({ ...base, systemPrompt: 'Review quickly' });
    expect(a).not.toBe(b);
  });

  it('different schemaVersion produces different hash', () => {
    const base = {
      modelId: 'model-a',
      systemPrompt: 'sys',
      userTemplate: 'tpl',
    };
    const a = computePromptHash({ ...base, schemaVersion: 1 });
    const b = computePromptHash({ ...base, schemaVersion: 2 });
    expect(a).not.toBe(b);
  });

  it('different modelId produces different hash', () => {
    const base = {
      schemaVersion: 1,
      systemPrompt: 'sys',
      userTemplate: 'tpl',
    };
    const a = computePromptHash({ ...base, modelId: 'model-a' });
    const b = computePromptHash({ ...base, modelId: 'model-b' });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// writeCacheWithMeta + loadCacheWithMeta round-trip
// ---------------------------------------------------------------------------

describe('writeCacheWithMeta / loadCacheWithMeta', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cache-meta-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('round-trips data through write then load', () => {
    const filePath = join(tempDir, 'test.json');
    const data = { findings: [{ id: 1 }] };
    const meta = { schema: 1, prompt_hash: 'sha256:abc123', model_id: 'model-a' };

    writeCacheWithMeta(filePath, data, meta);
    const loaded = loadCacheWithMeta<typeof data>(filePath, {
      schema: 1,
      promptHash: 'sha256:abc123',
    });

    expect(loaded).toEqual(data);
  });

  it('written file contains _meta with created_at and anatoly_version', () => {
    const filePath = join(tempDir, 'meta-check.json');
    writeCacheWithMeta(filePath, { x: 1 }, { schema: 1, prompt_hash: 'sha256:aaa', model_id: 'm' });

    const raw: CacheFile<{ x: number }> = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(raw._meta.schema).toBe(1);
    expect(raw._meta.prompt_hash).toBe('sha256:aaa');
    expect(raw._meta.model_id).toBe('m');
    expect(raw._meta.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof raw._meta.anatoly_version).toBe('string');
    expect(raw._meta.anatoly_version.length).toBeGreaterThan(0);
  });

  it('creates parent directories if missing', () => {
    const filePath = join(tempDir, 'deep', 'nested', 'dir', 'cache.json');
    writeCacheWithMeta(filePath, { ok: true }, { schema: 1, prompt_hash: 'sha256:x', model_id: 'm' });

    expect(existsSync(filePath)).toBe(true);
    const loaded = loadCacheWithMeta<{ ok: boolean }>(filePath, { schema: 1, promptHash: 'sha256:x' });
    expect(loaded).toEqual({ ok: true });
  });

  it('write is atomic — uses tmp + rename', () => {
    const filePath = join(tempDir, 'atomic.json');
    writeCacheWithMeta(filePath, { v: 1 }, { schema: 1, prompt_hash: 'sha256:a', model_id: 'm' });

    // The .tmp file should not remain after write
    expect(existsSync(filePath + '.tmp')).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });

  // --- cache miss scenarios ---

  it('returns null when file does not exist', () => {
    const result = loadCacheWithMeta(join(tempDir, 'nope.json'), { schema: 1, promptHash: 'sha256:x' });
    expect(result).toBeNull();
  });

  it('returns null when JSON is invalid', () => {
    const filePath = join(tempDir, 'bad.json');
    writeFileSync(filePath, 'not json {{{');
    expect(loadCacheWithMeta(filePath, { schema: 1, promptHash: 'sha256:x' })).toBeNull();
  });

  it('returns null when _meta is absent', () => {
    const filePath = join(tempDir, 'no-meta.json');
    writeFileSync(filePath, JSON.stringify({ data: { x: 1 } }));
    expect(loadCacheWithMeta(filePath, { schema: 1, promptHash: 'sha256:x' })).toBeNull();
  });

  it('returns null when schema does not match', () => {
    const filePath = join(tempDir, 'schema-mismatch.json');
    writeCacheWithMeta(filePath, { x: 1 }, { schema: 1, prompt_hash: 'sha256:a', model_id: 'm' });
    expect(loadCacheWithMeta(filePath, { schema: 2, promptHash: 'sha256:a' })).toBeNull();
  });

  it('returns null when prompt_hash does not match', () => {
    const filePath = join(tempDir, 'hash-mismatch.json');
    writeCacheWithMeta(filePath, { x: 1 }, { schema: 1, prompt_hash: 'sha256:aaa', model_id: 'm' });
    expect(loadCacheWithMeta(filePath, { schema: 1, promptHash: 'sha256:bbb' })).toBeNull();
  });

  it('never throws on any miss scenario', () => {
    // All misses should return null, not throw
    expect(() => loadCacheWithMeta('/nonexistent/path', { schema: 1, promptHash: 'x' })).not.toThrow();
    const badPath = join(tempDir, 'empty.json');
    writeFileSync(badPath, '');
    expect(() => loadCacheWithMeta(badPath, { schema: 1, promptHash: 'x' })).not.toThrow();
  });

  // --- invalidation integration test ---

  it('invalidation: write with hash X, read with hash Y returns null, re-write with Y works', () => {
    const filePath = join(tempDir, 'invalidation.json');

    writeCacheWithMeta(filePath, { v: 1 }, { schema: 1, prompt_hash: 'sha256:xxx', model_id: 'm' });
    expect(loadCacheWithMeta(filePath, { schema: 1, promptHash: 'sha256:yyy' })).toBeNull();

    writeCacheWithMeta(filePath, { v: 2 }, { schema: 1, prompt_hash: 'sha256:yyy', model_id: 'm' });
    expect(loadCacheWithMeta<{ v: number }>(filePath, { schema: 1, promptHash: 'sha256:yyy' })).toEqual({ v: 2 });
  });
});
