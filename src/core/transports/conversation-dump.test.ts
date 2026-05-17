// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDumpSlug, initConvDump } from './conversation-dump.js';
import { runWithContext } from '../../utils/log-context.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anatoly-dump-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildDumpSlug
// ---------------------------------------------------------------------------

describe('buildDumpSlug', () => {
  it('should produce 4-segment naming from ALS context', () => {
    const slug = runWithContext(
      { phase: 'review', composer: 'axes.correction', primitive: 'axes.correction-pass1', callId: 'c4f8a2' },
      () => buildDumpSlug(),
    );

    expect(slug).toBe('review__axes.correction__axes.correction-pass1__c4f8a2');
  });

  it('should produce different slug for different primitives', () => {
    const slug1 = runWithContext(
      { phase: 'review', composer: 'axes.correction', primitive: 'axes.correction-pass1', callId: 'c4f8a2' },
      () => buildDumpSlug(),
    );
    const slug2 = runWithContext(
      { phase: 'review', composer: 'axes.correction', primitive: 'axes.correction-verify', callId: 'd8e1b5' },
      () => buildDumpSlug(),
    );

    expect(slug1).toBe('review__axes.correction__axes.correction-pass1__c4f8a2');
    expect(slug2).toBe('review__axes.correction__axes.correction-verify__d8e1b5');
    expect(slug1).not.toBe(slug2);
  });

  it('should throw when ALS scope is absent', () => {
    expect(() => buildDumpSlug()).toThrow(/missing ALS scope/i);
  });

  it('should throw when phase is missing', () => {
    expect(() =>
      runWithContext(
        { composer: 'axes.correction', primitive: 'axes.correction-pass1', callId: 'abc' },
        () => buildDumpSlug(),
      ),
    ).toThrow(/phase/i);
  });

  it('should throw when composer is missing', () => {
    expect(() =>
      runWithContext(
        { phase: 'review', primitive: 'axes.correction-pass1', callId: 'abc' },
        () => buildDumpSlug(),
      ),
    ).toThrow(/composer/i);
  });

  it('should throw when primitive is missing', () => {
    expect(() =>
      runWithContext(
        { phase: 'review', composer: 'axes.correction', callId: 'abc' },
        () => buildDumpSlug(),
      ),
    ).toThrow(/primitive/i);
  });

  it('should throw when callId is missing', () => {
    expect(() =>
      runWithContext(
        { phase: 'review', composer: 'axes.correction', primitive: 'axes.correction-pass1' },
        () => buildDumpSlug(),
      ),
    ).toThrow(/callId/i);
  });
});

// ---------------------------------------------------------------------------
// 4-segment filename via initConvDump
// ---------------------------------------------------------------------------

describe('4-segment filename via initConvDump', () => {
  it('should create a file with 4-segment prefix naming', () => {
    const slug = 'review__axes.correction__axes.correction-pass1__c4f8a2';
    const dump = initConvDump({
      conversationDir: dir,
      conversationPrefix: slug,
      attempt: 1,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      userMessage: 'test',
    });

    expect(dump).toBeDefined();
    expect(dump!.fileName).toBe('review__axes.correction__axes.correction-pass1__c4f8a2__1.md');
    expect(existsSync(dump!.path)).toBe(true);
  });

  it('should use slug from buildDumpSlug as prefix', () => {
    const dump = runWithContext(
      { phase: 'review', composer: 'axes.correction', primitive: 'axes.correction-verify', callId: 'd8e1b5' },
      () => {
        const slug = buildDumpSlug();
        return initConvDump({
          conversationDir: dir,
          conversationPrefix: slug,
          attempt: 1,
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          userMessage: 'test',
        });
      },
    );

    expect(dump).toBeDefined();
    expect(dump!.fileName).toBe('review__axes.correction__axes.correction-verify__d8e1b5__1.md');
  });
});

// ---------------------------------------------------------------------------
// Concurrent composer executions get distinct callIds
// ---------------------------------------------------------------------------

describe('concurrent composer executions', () => {
  it('should produce distinct slugs for different callIds', async () => {
    const slugs: string[] = [];

    await Promise.all(
      ['call-001', 'call-002', 'call-003'].map((callId) =>
        runWithContext(
          { phase: 'review', composer: 'axes.utility', primitive: 'axes.utility', callId },
          async () => {
            // Simulate async work
            await new Promise((r) => setTimeout(r, 5));
            slugs.push(buildDumpSlug());
          },
        ),
      ),
    );

    expect(slugs).toHaveLength(3);
    const unique = new Set(slugs);
    expect(unique.size).toBe(3);
  });

  it('should produce distinct files for concurrent dumps', async () => {
    const files: string[] = [];

    await Promise.all(
      ['aaa111', 'bbb222', 'ccc333'].map((callId) =>
        runWithContext(
          { phase: 'review', composer: 'axes.utility', primitive: 'axes.utility', callId },
          async () => {
            await new Promise((r) => setTimeout(r, 5));
            const slug = buildDumpSlug();
            const dump = initConvDump({
              conversationDir: dir,
              conversationPrefix: slug,
              attempt: 1,
              model: 'claude-sonnet-4-6',
              provider: 'anthropic',
              userMessage: 'test',
            });
            if (dump) files.push(dump.fileName);
          },
        ),
      ),
    );

    expect(files).toHaveLength(3);
    const unique = new Set(files);
    expect(unique.size).toBe(3);
    // Each file should exist on disk
    for (const f of files) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });
});
