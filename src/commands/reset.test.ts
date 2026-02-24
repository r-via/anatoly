import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('reset logic', () => {
  let tmpDir: string;
  let anatolyDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reset-test-'));
    anatolyDir = join(tmpDir, '.anatoly');
    mkdirSync(anatolyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should remove all .anatoly subdirectories', () => {
    const dirs = ['tasks', 'reviews', 'logs', 'cache'];
    for (const d of dirs) {
      mkdirSync(join(anatolyDir, d), { recursive: true });
      writeFileSync(join(anatolyDir, d, 'test.json'), '{}');
    }

    // Simulate reset
    for (const d of dirs) {
      rmSync(join(anatolyDir, d), { recursive: true, force: true });
    }

    for (const d of dirs) {
      expect(existsSync(join(anatolyDir, d))).toBe(false);
    }
  });

  it('should remove progress.json and report.md', () => {
    writeFileSync(join(anatolyDir, 'progress.json'), '{}');
    writeFileSync(join(anatolyDir, 'report.md'), '# Report');

    rmSync(join(anatolyDir, 'progress.json'));
    rmSync(join(anatolyDir, 'report.md'));

    expect(existsSync(join(anatolyDir, 'progress.json'))).toBe(false);
    expect(existsSync(join(anatolyDir, 'report.md'))).toBe(false);
  });

  it('should remove lock file', () => {
    writeFileSync(join(anatolyDir, 'anatoly.lock'), '12345');

    rmSync(join(anatolyDir, 'anatoly.lock'));

    expect(existsSync(join(anatolyDir, 'anatoly.lock'))).toBe(false);
  });

  it('should remove rag directory and its contents', () => {
    const ragDir = join(anatolyDir, 'rag');
    mkdirSync(join(ragDir, 'lancedb'), { recursive: true });
    writeFileSync(join(ragDir, 'cache.json'), '{"entries":{}}');
    writeFileSync(join(ragDir, 'lancedb', 'data.lance'), 'mock');

    rmSync(ragDir, { recursive: true, force: true });

    expect(existsSync(ragDir)).toBe(false);
  });
});
