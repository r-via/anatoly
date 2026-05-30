// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneRefreshRuns } from './refresh-retention.js';

describe('pruneRefreshRuns', () => {
  let root: string;
  let refreshRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'refresh-retention-'));
    refreshRoot = join(root, 'refresh');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function mkRun(name: string): void {
    const dir = join(refreshRoot, name, 'conversations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'batch-1__1.md'), '# transcript\n');
  }

  // ISO-ish timestamps as produced by buildRefreshFn (`:`/`.` → `-`).
  const TS = [
    '2026-05-29T10-00-00-000Z',
    '2026-05-29T11-00-00-000Z',
    '2026-05-29T12-00-00-000Z',
    '2026-05-30T09-00-00-000Z',
    '2026-05-30T15-33-49-819Z',
    '2026-05-31T08-00-00-000Z',
  ];

  it('keeps the most recent N and removes the rest', () => {
    for (const ts of TS) mkRun(ts);

    const removed = pruneRefreshRuns(refreshRoot, 2);

    expect(removed.sort()).toEqual(TS.slice(0, 4).sort());
    const surviving = readdirSync(refreshRoot).sort();
    expect(surviving).toEqual([
      '2026-05-30T15-33-49-819Z',
      '2026-05-31T08-00-00-000Z',
    ]);
  });

  it('is a no-op when run count is at or below keep', () => {
    mkRun(TS[0]);
    mkRun(TS[1]);

    expect(pruneRefreshRuns(refreshRoot, 5)).toEqual([]);
    expect(readdirSync(refreshRoot).length).toBe(2);
  });

  it('returns empty when the refresh root does not exist', () => {
    expect(pruneRefreshRuns(join(root, 'nope'), 3)).toEqual([]);
  });

  it('removes everything when keep is 0', () => {
    mkRun(TS[0]);
    mkRun(TS[1]);

    const removed = pruneRefreshRuns(refreshRoot, 0);
    expect(removed.length).toBe(2);
    expect(readdirSync(refreshRoot).length).toBe(0);
    expect(existsSync(refreshRoot)).toBe(true);
  });

  it('ignores stray files at the refresh root (only prunes directories)', () => {
    for (const ts of TS) mkRun(ts);
    writeFileSync(join(refreshRoot, 'README.txt'), 'not a run dir');

    pruneRefreshRuns(refreshRoot, 1);

    expect(existsSync(join(refreshRoot, 'README.txt'))).toBe(true);
    const dirs = readdirSync(refreshRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs).toEqual(['2026-05-31T08-00-00-000Z']);
  });
});
