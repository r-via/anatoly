// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 55.10 — Integration tests for LLM-driven detection of new conflicts.
 *
 * Uses a mocked TransportRouter that returns canned JSON responses so we
 * exercise the full enrichment + dedup + persistence pipeline without
 * touching real LLMs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  enrichDetectedConflict,
  detectNewConflictsViaLlm,
  runDocConflictDetection,
} from './doc-conflict-detector.js';
import { loadDocConflicts } from './doc-conflict-store.js';
import type { DetectedConflictItem } from './doc-conflict-llm.js';
import type { Config } from '../schemas/config.js';
import type { Task } from '../schemas/task.js';
import type { TransportRouter } from './transports/index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'doc-conflict-llm-int-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 2,
    project_name: 'test',
    project_root: tmp,
    models: { quality: 'anthropic/claude-sonnet-4-6', fast: 'anthropic/claude-haiku-4-5' },
    agents: { enabled: true, max_turns: 30 },
    axes: {},
    documentation: {
      reference: { paths: ['docs/**/*.md'] },
      internal: { mode: 'full' },
    },
    ...overrides,
  } as unknown as Config;
}

function makeTasks(): Task[] {
  return [
    {
      file: 'src/foo.ts',
      symbols: [
        { name: 'doThing', kind: 'function', exported: true, line_start: 10, line_end: 20, parent: null, signature: 'doThing(s: string)' },
      ],
    } as unknown as Task,
  ];
}

/**
 * Create a mock TransportRouter whose agenticQuery returns a canned response.
 * Captures the call so tests can assert what was sent.
 */
function makeMockRouter(responseJson: string, opts: { throwError?: Error } = {}): TransportRouter & { calls: Array<{ systemPrompt: string; userMessage: string; model: string }> } {
  const calls: Array<{ systemPrompt: string; userMessage: string; model: string }> = [];
  const mock = {
    calls,
    agenticQuery: async (params: { systemPrompt: string; userMessage: string; model: string }) => {
      calls.push({ systemPrompt: params.systemPrompt, userMessage: params.userMessage, model: params.model });
      if (opts.throwError) throw opts.throwError;
      return {
        text: responseJson,
        costUsd: 0.01,
        durationMs: 100,
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        transcript: '',
      };
    },
  };
  return mock as unknown as TransportRouter & { calls: typeof calls };
}

function seedProject(): { projectRoot: string; fragmentsDir: string } {
  // Seed code file
  mkdirSync(join(tmp, 'src'), { recursive: true });
  writeFileSync(
    join(tmp, 'src/foo.ts'),
    'export function doThing(buf: Buffer): Promise<User> {\n  return Promise.resolve(/* ... */);\n}\n',
  );

  // Seed reference doc
  mkdirSync(join(tmp, 'docs'), { recursive: true });
  writeFileSync(join(tmp, 'docs/api.md'), '# API\n\n`doThing(s: string)` returns the user synchronously.\n');

  // Seed internal-doc fragments
  const fragmentsDir = join(tmp, '.anatoly/state/internal-docs');
  mkdirSync(join(fragmentsDir, '05-modules'), { recursive: true });
  writeFileSync(
    join(fragmentsDir, '05-modules/core.md'),
    '## doThing\n\nAccepts a Buffer, returns Promise<User>.\n',
  );

  return { projectRoot: tmp, fragmentsDir };
}

// ---------------------------------------------------------------------------
// enrichDetectedConflict
// ---------------------------------------------------------------------------

describe('Story 55.10 — enrichDetectedConflict', () => {
  it('produces a valid DocConflict with hash, signals, id', () => {
    seedProject();
    const item: DetectedConflictItem = {
      file: 'src/foo.ts',
      symbol: 'doThing',
      line_start: 1,
      line_end: 3,
      reference_path: 'docs/api.md',
      reference_text: 'doThing accepts a string.',
      code_summary: 'doThing accepts a Buffer.',
      divergence: 'string vs Buffer.',
    };
    const conflict = enrichDetectedConflict(tmp, item);
    expect(conflict).not.toBeNull();
    expect(conflict!.anchor.file).toBe('src/foo.ts');
    expect(conflict!.anchor.symbol).toBe('doThing');
    expect(conflict!.anchor.code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(conflict!.id).toMatch(/^[a-f0-9]{16}$/);
    expect(conflict!.verdict).toBe('pending');
    expect(conflict!.status).toBe('active');
    expect(conflict!.signals.presumption).toMatch(/doc-stale|code-drift|unknown/);
  });

  it('returns null when code file does not exist', () => {
    const item: DetectedConflictItem = {
      file: 'src/nonexistent.ts',
      reference_path: 'docs/api.md',
      reference_text: 'x',
      code_summary: 'y',
      divergence: 'mismatch',
    };
    const conflict = enrichDetectedConflict(tmp, item);
    expect(conflict).toBeNull();
  });

  it('handles items without symbol or line range', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src/bar.ts'), 'export const X = 1;\n');
    const item: DetectedConflictItem = {
      file: 'src/bar.ts',
      reference_path: 'README.md',
      reference_text: 'X is exported',
      code_summary: 'X is hidden',
      divergence: 'mismatch',
    };
    const conflict = enrichDetectedConflict(tmp, item);
    expect(conflict).not.toBeNull();
    expect(conflict!.anchor.symbol).toBeUndefined();
    expect(conflict!.anchor.line_range).toBeUndefined();
  });

  it('generates stable id for same anchor', () => {
    seedProject();
    const item: DetectedConflictItem = {
      file: 'src/foo.ts',
      symbol: 'doThing',
      line_start: 1,
      line_end: 3,
      reference_path: 'docs/api.md',
      reference_text: 'a',
      code_summary: 'b',
      divergence: 'c',
    };
    const c1 = enrichDetectedConflict(tmp, item);
    const c2 = enrichDetectedConflict(tmp, item);
    expect(c1!.id).toBe(c2!.id);
  });
});

// ---------------------------------------------------------------------------
// detectNewConflictsViaLlm — direct entry point
// ---------------------------------------------------------------------------

describe('Story 55.10 — detectNewConflictsViaLlm', () => {
  it('returns enriched conflicts from a mocked LLM response', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const router = makeMockRouter(JSON.stringify({
      conflicts: [
        {
          file: 'src/foo.ts',
          symbol: 'doThing',
          line_start: 1,
          line_end: 3,
          reference_path: 'docs/api.md',
          reference_text: 'doThing accepts a string.',
          code_summary: 'doThing accepts a Buffer.',
          divergence: 'string vs Buffer.',
        },
      ],
    }));

    const conflicts = await detectNewConflictsViaLlm(
      {
        projectRoot,
        config: makeConfig(),
        tasks: makeTasks(),
        fragmentsDir,
        router,
      },
      new Set(),
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].anchor.file).toBe('src/foo.ts');
    expect(conflicts[0].code_summary).toBe('doThing accepts a Buffer.');
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0].userMessage).toContain('REFERENCE_DOCS');
    expect(router.calls[0].userMessage).toContain('INTERNAL_DOCS');
    expect(router.calls[0].userMessage).toContain('CODE_SURFACE');
  });

  it('deduplicates against existing ids', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const router = makeMockRouter(JSON.stringify({
      conflicts: [
        {
          file: 'src/foo.ts',
          symbol: 'doThing',
          line_start: 1,
          line_end: 3,
          reference_path: 'docs/api.md',
          reference_text: 'a',
          code_summary: 'b',
          divergence: 'c',
        },
      ],
    }));

    // First call to compute the id
    const first = await detectNewConflictsViaLlm(
      { projectRoot, config: makeConfig(), tasks: makeTasks(), fragmentsDir, router },
      new Set(),
    );
    expect(first).toHaveLength(1);

    // Second call with the id already known — should be deduped
    const second = await detectNewConflictsViaLlm(
      { projectRoot, config: makeConfig(), tasks: makeTasks(), fragmentsDir, router },
      new Set([first[0].id]),
    );
    expect(second).toHaveLength(0);
  });

  it('returns empty when router throws', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const router = makeMockRouter('', { throwError: new Error('boom') });

    const conflicts = await detectNewConflictsViaLlm(
      { projectRoot, config: makeConfig(), tasks: makeTasks(), fragmentsDir, router },
      new Set(),
    );
    expect(conflicts).toEqual([]);
  });

  it('returns empty when response is unparseable', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const router = makeMockRouter('garbage not json');

    const conflicts = await detectNewConflictsViaLlm(
      { projectRoot, config: makeConfig(), tasks: makeTasks(), fragmentsDir, router },
      new Set(),
    );
    expect(conflicts).toEqual([]);
  });

  it('returns empty when no router provided', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const conflicts = await detectNewConflictsViaLlm(
      { projectRoot, config: makeConfig(), tasks: makeTasks(), fragmentsDir },
      new Set(),
    );
    expect(conflicts).toEqual([]);
  });

  it('skips entries whose code file is missing on disk', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const router = makeMockRouter(JSON.stringify({
      conflicts: [
        {
          file: 'src/ghost.ts',
          reference_path: 'docs/api.md',
          reference_text: 'a',
          code_summary: 'b',
          divergence: 'c',
        },
      ],
    }));

    const conflicts = await detectNewConflictsViaLlm(
      { projectRoot, config: makeConfig(), tasks: makeTasks(), fragmentsDir, router },
      new Set(),
    );
    expect(conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runDocConflictDetection — end-to-end with router
// ---------------------------------------------------------------------------

describe('Story 55.10 — runDocConflictDetection end-to-end', () => {
  it('persists new conflicts into doc-conflicts.yaml and reports correct summary', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const router = makeMockRouter(JSON.stringify({
      conflicts: [
        {
          file: 'src/foo.ts',
          symbol: 'doThing',
          line_start: 1,
          line_end: 3,
          reference_path: 'docs/api.md',
          reference_text: 'doThing accepts a string.',
          code_summary: 'doThing accepts a Buffer.',
          divergence: 'string vs Buffer.',
        },
      ],
    }));

    const summary = await runDocConflictDetection({
      projectRoot,
      config: makeConfig(),
      tasks: makeTasks(),
      fragmentsDir,
      router,
    });

    expect(summary.newConflicts).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.applied).toBe(0);
    expect(summary.stale).toBe(0);

    const lock = loadDocConflicts(projectRoot);
    expect(lock).not.toBeNull();
    expect(lock!.entries).toHaveLength(1);
    expect(lock!.entries[0].verdict).toBe('pending');
    expect(lock!.entries[0].status).toBe('active');
  });

  it('does not duplicate an existing conflict on re-run', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const payload = JSON.stringify({
      conflicts: [
        {
          file: 'src/foo.ts',
          symbol: 'doThing',
          line_start: 1,
          line_end: 3,
          reference_path: 'docs/api.md',
          reference_text: 'a',
          code_summary: 'b',
          divergence: 'c',
        },
      ],
    });

    // First run creates the conflict
    await runDocConflictDetection({
      projectRoot, config: makeConfig(), tasks: makeTasks(), fragmentsDir,
      router: makeMockRouter(payload),
    });

    // Second run returns the same conflict — should NOT duplicate
    const summary = await runDocConflictDetection({
      projectRoot, config: makeConfig(), tasks: makeTasks(), fragmentsDir,
      router: makeMockRouter(payload),
    });

    expect(summary.newConflicts).toBe(0);
    const lock = loadDocConflicts(projectRoot);
    expect(lock!.entries).toHaveLength(1);
  });

  it('short-circuits with newConflicts: 0 in lite mode', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const summary = await runDocConflictDetection({
      projectRoot,
      config: makeConfig({ documentation: { reference: { paths: ['docs/**/*.md'] }, internal: { mode: 'lite' } } } as unknown as Partial<Config>),
      tasks: makeTasks(),
      fragmentsDir,
      router: makeMockRouter('should not be called'),
    });
    expect(summary.newConflicts).toBe(0);
  });

  it('short-circuits with newConflicts: 0 in off mode', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const summary = await runDocConflictDetection({
      projectRoot,
      config: makeConfig({ documentation: { reference: { paths: ['docs/**/*.md'] }, internal: { mode: 'off' } } } as unknown as Partial<Config>),
      tasks: makeTasks(),
      fragmentsDir,
      router: makeMockRouter('should not be called'),
    });
    expect(summary.newConflicts).toBe(0);
  });

  it('works without a router — preserves existing lock state', async () => {
    const { projectRoot, fragmentsDir } = seedProject();
    const summary = await runDocConflictDetection({
      projectRoot,
      config: makeConfig(),
      tasks: makeTasks(),
      fragmentsDir,
    });
    expect(summary.newConflicts).toBe(0);
  });
});
