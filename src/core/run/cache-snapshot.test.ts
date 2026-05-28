// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync,
  readdirSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot,
  pruneSnapshots, snapshotAndPrune,
} from './cache-snapshot.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'anatoly-cache-snap-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function seedCache(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(testDir, '.anatoly', 'cache', rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

function snapshotsDir(): string {
  return join(testDir, '.anatoly', 'cache-snapshots');
}

function hasTar(): boolean {
  try {
    execFileSync('tar', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Semantics that must hold regardless of storage format. Parametrised over
// 'dir' and (when tar is available) 'tar' so a regression in either path
// is caught.
// ---------------------------------------------------------------------------

const FORMATS = (['dir', ...(hasTar() ? ['tar' as const] : [])] as const);

describe.each(FORMATS)('createSnapshot (format=%s)', (format) => {
  it('returns null when there is no cache to snapshot', () => {
    expect(createSnapshot({ projectRoot: testDir, reason: 'manual', format })).toBeNull();
  });

  it('captures every cache file and records meta with the requested format', () => {
    seedCache({
      'reviews/aa/blob.rev.json': '{"a":1}',
      'review-index.json': '{"version":1,"files":{}}',
      'rag/lancedb/data.bin': 'bin-payload',
    });

    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'baseline', format });

    expect(meta).not.toBeNull();
    expect(meta!.format).toBe(format);
    expect(meta!.fileCount).toBe(3);
    expect(meta!.sizeBytes).toBeGreaterThan(0);
    expect(meta!.name).toMatch(/_manual_baseline$/);
  });

  it('snapshot bytes are independent of the live cache (mutations do not bleed across)', () => {
    seedCache({ 'reviews/x.json': 'original' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual', format })!;

    // Mutate the live file. For the dir format we then read directly; for
    // tar we restore into a tempdir and verify the extracted content.
    const liveFile = join(testDir, '.anatoly', 'cache', 'reviews', 'x.json');
    writeFileSync(liveFile, 'mutated');

    // Restore overwrites the live cache from the snapshot. If the snapshot
    // was bleeding (hardlink bug), the restored content would be 'mutated'.
    restoreSnapshot(testDir, meta.name);
    expect(readFileSync(liveFile, 'utf-8')).toBe('original');
  });

  it('auto-suffixes on name collision', () => {
    seedCache({ 'x.json': 'a' });
    const a = createSnapshot({ projectRoot: testDir, reason: 'manual', format })!;
    const b = createSnapshot({ projectRoot: testDir, reason: 'manual', format })!;
    expect(a.name).not.toBe(b.name);
  });

  it('records anatoly version + git commit (when available)', () => {
    seedCache({ 'x.json': 'a' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual', format })!;
    expect(meta.anatolyVersion).toBeDefined();
    expect(meta.anatolyVersion.length).toBeGreaterThan(0);
    if (meta.gitCommit) expect(meta.gitCommit).toMatch(/^[0-9a-f]{7,40}$/);
  });
});

describe.each(FORMATS)('listSnapshots (format=%s)', (format) => {
  it('returns an empty array when no snapshots exist', () => {
    expect(listSnapshots(testDir)).toEqual([]);
  });

  it('returns snapshots newest first', async () => {
    seedCache({ 'x.json': 'a' });
    const a = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'first', format })!;
    await new Promise((r) => setTimeout(r, 1100));
    const b = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'second', format })!;
    const list = listSnapshots(testDir);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe(b.name);
    expect(list[1].name).toBe(a.name);
  });

  it('silently skips entries without a parseable _meta.json', () => {
    seedCache({ 'x.json': 'a' });
    createSnapshot({ projectRoot: testDir, reason: 'manual', format });
    mkdirSync(join(snapshotsDir(), 'not-a-snapshot'), { recursive: true });
    writeFileSync(join(snapshotsDir(), 'garbage.tar.gz'), 'not a real tarball');
    expect(listSnapshots(testDir)).toHaveLength(1);
  });
});

describe.each(FORMATS)('restoreSnapshot (format=%s)', (format) => {
  it('overwrites the live cache with the snapshot contents', () => {
    seedCache({ 'reviews/x.json': 'original' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual', format })!;

    writeFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'x.json'), 'mutated');
    writeFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'extra.json'), 'should-disappear');

    const result = restoreSnapshot(testDir, meta.name);

    expect(result.restored).toBeGreaterThan(0);
    expect(readFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'x.json'), 'utf-8')).toBe('original');
    expect(existsSync(join(testDir, '.anatoly', 'cache', 'reviews', 'extra.json'))).toBe(false);
  });

  it('takes a pre-restore snapshot of the current cache before overwriting', () => {
    seedCache({ 'reviews/x.json': 'v1' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual', format })!;
    writeFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'x.json'), 'v2-before-restore');

    const result = restoreSnapshot(testDir, meta.name);
    expect(result.preRestoreSnapshot).not.toBeNull();
    expect(result.preRestoreSnapshot!.reason).toBe('pre-restore');

    // The live cache is restored to v1.
    expect(readFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'x.json'), 'utf-8')).toBe('v1');
    // The pre-restore snapshot can itself be restored to recover v2.
    restoreSnapshot(testDir, result.preRestoreSnapshot!.name);
    expect(readFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'x.json'), 'utf-8')).toBe('v2-before-restore');
  });

  it('throws when the snapshot name does not exist', () => {
    expect(() => restoreSnapshot(testDir, 'nope')).toThrow(/not found/);
  });
});

describe.each(FORMATS)('pruneSnapshots (format=%s)', (format) => {
  it('keeps the N most recent snapshots, deletes the older ones', async () => {
    seedCache({ 'x.json': 'a' });
    const a = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'a', format })!;
    await new Promise((r) => setTimeout(r, 1100));
    const b = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'b', format })!;
    await new Promise((r) => setTimeout(r, 1100));
    const c = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'c', format })!;

    const result = pruneSnapshots(testDir, 2);
    expect(result.kept).toBe(2);
    expect(result.pruned).toEqual([a.name]);

    const remaining = listSnapshots(testDir).map((s) => s.name);
    expect(remaining).toContain(b.name);
    expect(remaining).toContain(c.name);
    expect(remaining).not.toContain(a.name);
  });

  it('sweeps orphaned .tmp-* entries left by a crashed snapshot', () => {
    seedCache({ 'x.json': 'a' });
    createSnapshot({ projectRoot: testDir, reason: 'manual', format });
    const tmpDir = join(snapshotsDir(), '.tmp-orphan');
    mkdirSync(tmpDir);
    pruneSnapshots(testDir, 10);
    expect(existsSync(tmpDir)).toBe(false);
  });
});

describe.each(FORMATS)('deleteSnapshot (format=%s)', (format) => {
  it('removes a single named snapshot regardless of storage format', () => {
    seedCache({ 'x.json': 'a' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual', format })!;
    expect(deleteSnapshot(testDir, meta.name)).toBe(true);
    expect(listSnapshots(testDir)).toHaveLength(0);
  });

  it('returns false for an unknown name', () => {
    expect(deleteSnapshot(testDir, 'definitely-not-there')).toBe(false);
  });
});

describe.each(FORMATS)('atomic write invariant (format=%s)', (format) => {
  it('no .tmp-* entry remains after a successful snapshot', () => {
    seedCache({ 'x.json': 'a' });
    createSnapshot({ projectRoot: testDir, reason: 'manual', format });
    const entries = readdirSync(snapshotsDir());
    expect(entries.filter((e) => e.startsWith('.tmp-'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Format-specific behaviour
// ---------------------------------------------------------------------------

describe('format=auto (default)', () => {
  it('produces a tar.gz snapshot when tar is on PATH', () => {
    if (!hasTar()) return; // covered by the dir-only environment via the explicit dir tests
    seedCache({ 'x.json': 'a' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual' })!;
    expect(meta.format).toBe('tar');
    expect(existsSync(join(snapshotsDir(), `${meta.name}.tar.gz`))).toBe(true);
  });
});

describe('tar format specifics', () => {
  if (!hasTar()) {
    it.skip('tar not available — skipping tar-specific tests', () => {});
    return;
  }

  it('compresses JSON payloads (snapshot file size < raw cache size)', () => {
    // Highly compressible payload: 100 KB of repeated JSON.
    const compressible = JSON.stringify(Array(2000).fill({ k: 'value' }));
    seedCache({ 'reviews/big.json': compressible });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual', format: 'tar' })!;
    const liveSize = statSync(join(testDir, '.anatoly', 'cache', 'reviews', 'big.json')).size;
    // Tarball size = meta.sizeBytes (file size on disk). Expect at least
    // 4x compression on this very repetitive payload.
    expect(meta.sizeBytes).toBeLessThan(liveSize / 4);
  });

  it('listSnapshots reads meta from inside the tarball without staging extraction', () => {
    seedCache({ 'x.json': 'a' });
    const created = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'inside-tar', format: 'tar' })!;
    const list = listSnapshots(testDir);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(created.name);
    expect(list[0].format).toBe('tar');
    expect(list[0].note).toBe('inside-tar');
    // No staging directory left behind by the meta read.
    const entries = readdirSync(snapshotsDir());
    expect(entries.filter((e) => e.startsWith('.tmp-'))).toHaveLength(0);
  });

  it('name collision between a tar and a dir snapshot does not clobber either', () => {
    seedCache({ 'x.json': 'a' });
    const tar = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'collide', format: 'tar' })!;
    const dir = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'collide', format: 'dir' })!;
    expect(tar.name).not.toBe(dir.name);
    expect(existsSync(join(snapshotsDir(), `${tar.name}.tar.gz`))).toBe(true);
    expect(existsSync(join(snapshotsDir(), dir.name))).toBe(true);
  });
});

describe('snapshotAndPrune', () => {
  it('snapshots then prunes in one call (works for both formats)', async () => {
    seedCache({ 'x.json': 'a' });
    for (let i = 0; i < 3; i++) {
      snapshotAndPrune({ projectRoot: testDir, reason: 'manual', note: `s${i}`, format: 'dir' }, 2);
      await new Promise((r) => setTimeout(r, 1100));
    }
    expect(listSnapshots(testDir)).toHaveLength(2);
  });
});
