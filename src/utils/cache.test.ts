// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeFileHash, computeContentHash, toOutputName, atomicWriteJson, readProgress } from './cache.js';

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

  it('should produce identical hash for CRLF vs LF files (normalization)', () => {
    const fileLF = join(tempDir, 'lf.ts');
    const fileCRLF = join(tempDir, 'crlf.ts');
    writeFileSync(fileLF, 'line1\nline2\n');
    writeFileSync(fileCRLF, 'line1\r\nline2\r\n');
    expect(computeFileHash(fileLF)).toBe(computeFileHash(fileCRLF));
  });

  it('should normalize lone \\r to \\n', () => {
    const fileLF = join(tempDir, 'lf.ts');
    const fileCR = join(tempDir, 'cr.ts');
    writeFileSync(fileLF, 'a\nb\n');
    writeFileSync(fileCR, 'a\rb\r');
    expect(computeFileHash(fileLF)).toBe(computeFileHash(fileCR));
  });
});

describe('computeContentHash', () => {
  it('should return 64-char hex SHA-256', () => {
    const hash = computeContentHash('const x = 42;');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should normalize CRLF to LF before hashing', () => {
    const hashLF = computeContentHash('line1\nline2\n');
    const hashCRLF = computeContentHash('line1\r\nline2\r\n');
    expect(hashLF).toBe(hashCRLF);
  });

  it('should normalize lone CR to LF before hashing', () => {
    const hashLF = computeContentHash('a\nb\n');
    const hashCR = computeContentHash('a\rb\r');
    expect(hashLF).toBe(hashCR);
  });

  it('should produce different hashes for different content', () => {
    expect(computeContentHash('hello')).not.toBe(computeContentHash('world'));
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
