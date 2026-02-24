import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeFileHash, toOutputName, atomicWriteJson, readProgress } from './cache.js';

describe('computeFileHash', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-cache-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return consistent SHA-256 hash for same content', () => {
    const filePath = join(tempDir, 'test.ts');
    writeFileSync(filePath, 'const x = 42;');
    const hash1 = computeFileHash(filePath);
    const hash2 = computeFileHash(filePath);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it('should return different hash for different content', () => {
    const file1 = join(tempDir, 'a.ts');
    const file2 = join(tempDir, 'b.ts');
    writeFileSync(file1, 'const a = 1;');
    writeFileSync(file2, 'const b = 2;');
    expect(computeFileHash(file1)).not.toBe(computeFileHash(file2));
  });
});

describe('toOutputName', () => {
  it('should convert file paths to output names', () => {
    expect(toOutputName('src/utils/format.ts')).toBe('src-utils-format');
    expect(toOutputName('src/hooks/use-auth.tsx')).toBe('src-hooks-use-auth');
    expect(toOutputName('index.ts')).toBe('index');
  });
});

describe('atomicWriteJson', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-atomic-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write valid JSON to disk', () => {
    const filePath = join(tempDir, 'sub', 'data.json');
    atomicWriteJson(filePath, { version: 1, count: 42 });
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content).toEqual({ version: 1, count: 42 });
  });
});

describe('readProgress', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-progress-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return null when file does not exist', () => {
    expect(readProgress(join(tempDir, 'nonexistent.json'))).toBeNull();
  });

  it('should read valid progress JSON', () => {
    const filePath = join(tempDir, 'progress.json');
    const data = { version: 1, started_at: '2026-01-01', files: {} };
    writeFileSync(filePath, JSON.stringify(data));
    expect(readProgress(filePath)).toEqual(data);
  });
});
