// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

describe('createSnapshot', () => {
  it('returns null when there is no cache to snapshot', () => {
    expect(createSnapshot({ projectRoot: testDir, reason: 'manual' })).toBeNull();
  });

  it('mirrors every cache file into the snapshot directory', () => {
    seedCache({
      'reviews/aa/blob.rev.json': '{"a":1}',
      'review-index.json': '{"version":1,"files":{}}',
      'rag/lancedb/data.bin': 'bin-payload',
    });

    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'baseline' });

    expect(meta).not.toBeNull();
    expect(meta!.fileCount).toBe(3);
    expect(meta!.sizeBytes).toBeGreaterThan(0);
    expect(meta!.name).toMatch(/_manual_baseline$/);

    const snapDir = join(testDir, '.anatoly', 'cache-snapshots', meta!.name);
    expect(existsSync(join(snapDir, '_meta.json'))).toBe(true);
    expect(readFileSync(join(snapDir, 'cache', 'reviews', 'aa', 'blob.rev.json'), 'utf-8')).toBe('{"a":1}');
    expect(readFileSync(join(snapDir, 'cache', 'review-index.json'), 'utf-8')).toBe('{"version":1,"files":{}}');
    expect(readFileSync(join(snapDir, 'cache', 'rag', 'lancedb', 'data.bin'), 'utf-8')).toBe('bin-payload');
  });

  it('snapshot files are independent of the live cache (mutations do not bleed across)', () => {
    seedCache({ 'reviews/x.json': 'original' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual' })!;
    const liveFile = join(testDir, '.anatoly', 'cache', 'reviews', 'x.json');
    const snapFile = join(testDir, '.anatoly', 'cache-snapshots', meta.name, 'cache', 'reviews', 'x.json');

    // Independence is the load-bearing invariant: a snapshot must capture
    // a frozen-in-time view. An earlier hardlink-based implementation
    // shared inodes between live and snapshot, so writes to the live
    // cache mutated the snapshot too, silently defeating the entire
    // safety net. Full file copies guarantee this independence.
    expect(statSync(liveFile).ino).not.toBe(statSync(snapFile).ino);
    writeFileSync(liveFile, 'mutated');
    expect(readFileSync(snapFile, 'utf-8')).toBe('original');
  });

  it('auto-suffixes on directory name collision', () => {
    seedCache({ 'x.json': 'a' });
    const a = createSnapshot({ projectRoot: testDir, reason: 'manual' })!;
    const b = createSnapshot({ projectRoot: testDir, reason: 'manual' })!;
    expect(a.name).not.toBe(b.name);
    // Either timestamps differ (most cases) or the second got _2 suffix
    expect(b.name === a.name || b.name.endsWith('_2') || b.name > a.name).toBe(true);
  });

  it('records anatoly version + git commit (when available)', () => {
    seedCache({ 'x.json': 'a' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual' })!;
    expect(meta.anatolyVersion).toBeDefined();
    expect(meta.anatolyVersion.length).toBeGreaterThan(0);
    // gitCommit is undefined when testDir is not a git repo (the normal case
    // for tmp dirs). Just assert the field is either absent or a hex string.
    if (meta.gitCommit) {
      expect(meta.gitCommit).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });
});

describe('listSnapshots', () => {
  it('returns an empty array when no snapshots exist', () => {
    expect(listSnapshots(testDir)).toEqual([]);
  });

  it('returns snapshots newest first', async () => {
    seedCache({ 'x.json': 'a' });
    const a = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'first' })!;
    // Force a different timestamp on the second snapshot. The dir name
    // includes seconds, so we sleep 1.1s to guarantee a distinct stamp.
    await new Promise((r) => setTimeout(r, 1100));
    const b = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'second' })!;
    const list = listSnapshots(testDir);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe(b.name);
    expect(list[1].name).toBe(a.name);
  });

  it('silently skips directories without a parseable _meta.json', () => {
    seedCache({ 'x.json': 'a' });
    createSnapshot({ projectRoot: testDir, reason: 'manual' });
    // Drop a garbage directory in the snapshots root
    mkdirSync(join(testDir, '.anatoly', 'cache-snapshots', 'not-a-snapshot'), { recursive: true });
    expect(listSnapshots(testDir)).toHaveLength(1);
  });
});

describe('restoreSnapshot', () => {
  it('overwrites the live cache with the snapshot contents and returns the count', () => {
    seedCache({ 'reviews/x.json': 'original' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual' })!;

    // Corrupt the live cache
    writeFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'x.json'), 'mutated');
    writeFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'extra.json'), 'should-disappear');

    const result = restoreSnapshot(testDir, meta.name);

    expect(result.restored).toBeGreaterThan(0);
    expect(readFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'x.json'), 'utf-8')).toBe('original');
    expect(existsSync(join(testDir, '.anatoly', 'cache', 'reviews', 'extra.json'))).toBe(false);
  });

  it('takes a pre-restore snapshot of the current cache before overwriting', () => {
    seedCache({ 'reviews/x.json': 'v1' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual' })!;

    // Mutate the live cache so the pre-restore snapshot has different contents
    writeFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'x.json'), 'v2-before-restore');

    const result = restoreSnapshot(testDir, meta.name);
    expect(result.preRestoreSnapshot).not.toBeNull();
    expect(result.preRestoreSnapshot!.reason).toBe('pre-restore');

    // The pre-restore snapshot captured the mutated content (v2)
    const preFile = join(
      testDir, '.anatoly', 'cache-snapshots',
      result.preRestoreSnapshot!.name, 'cache', 'reviews', 'x.json',
    );
    expect(readFileSync(preFile, 'utf-8')).toBe('v2-before-restore');
    // Live cache restored to the original v1
    expect(readFileSync(join(testDir, '.anatoly', 'cache', 'reviews', 'x.json'), 'utf-8')).toBe('v1');
  });

  it('throws when the snapshot name does not exist', () => {
    expect(() => restoreSnapshot(testDir, 'nope')).toThrow(/not found/);
  });
});

describe('pruneSnapshots', () => {
  it('keeps the N most recent snapshots, deletes the older ones', async () => {
    seedCache({ 'x.json': 'a' });
    const a = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'a' })!;
    await new Promise((r) => setTimeout(r, 1100));
    const b = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'b' })!;
    await new Promise((r) => setTimeout(r, 1100));
    const c = createSnapshot({ projectRoot: testDir, reason: 'manual', note: 'c' })!;

    const result = pruneSnapshots(testDir, 2);
    expect(result.kept).toBe(2);
    expect(result.pruned).toEqual([a.name]);

    const remaining = listSnapshots(testDir).map((s) => s.name);
    expect(remaining).toContain(b.name);
    expect(remaining).toContain(c.name);
    expect(remaining).not.toContain(a.name);
  });

  it('is a no-op when count <= keep', () => {
    seedCache({ 'x.json': 'a' });
    createSnapshot({ projectRoot: testDir, reason: 'manual' });
    const result = pruneSnapshots(testDir, 5);
    expect(result.pruned).toHaveLength(0);
  });

  it('sweeps orphaned .tmp-* dirs left by a crashed snapshot', () => {
    seedCache({ 'x.json': 'a' });
    createSnapshot({ projectRoot: testDir, reason: 'manual' });
    const tmpPath = join(testDir, '.anatoly', 'cache-snapshots', '.tmp-orphan');
    mkdirSync(tmpPath);
    pruneSnapshots(testDir, 10);
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe('snapshotAndPrune', () => {
  it('snapshots then prunes in one call (default keep=5)', async () => {
    seedCache({ 'x.json': 'a' });
    for (let i = 0; i < 3; i++) {
      snapshotAndPrune({ projectRoot: testDir, reason: 'manual', note: `s${i}` }, 2);
      await new Promise((r) => setTimeout(r, 1100));
    }
    // After 3 snapshots with keep=2, exactly 2 remain.
    expect(listSnapshots(testDir)).toHaveLength(2);
  });
});

describe('deleteSnapshot', () => {
  it('removes a single named snapshot', () => {
    seedCache({ 'x.json': 'a' });
    const meta = createSnapshot({ projectRoot: testDir, reason: 'manual' })!;
    expect(deleteSnapshot(testDir, meta.name)).toBe(true);
    expect(listSnapshots(testDir)).toHaveLength(0);
  });

  it('returns false for an unknown name', () => {
    expect(deleteSnapshot(testDir, 'definitely-not-there')).toBe(false);
  });
});

describe('snapshot directory layout invariants', () => {
  it('atomic write: only the final dir name exists after a successful snapshot', () => {
    seedCache({ 'x.json': 'a' });
    createSnapshot({ projectRoot: testDir, reason: 'manual' });
    const entries = readdirSync(join(testDir, '.anatoly', 'cache-snapshots'));
    expect(entries.filter((e) => e.startsWith('.tmp-'))).toHaveLength(0);
    expect(entries.filter((e) => !e.startsWith('.tmp-'))).toHaveLength(1);
  });
});
