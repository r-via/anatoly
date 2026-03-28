// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadTasks,
  countTokens,
  formatTokenCount,
  estimateFileSeconds,
  BASE_SECONDS,
  SECONDS_PER_SYMBOL,
} from './estimator.js';

describe('countTokens', () => {
  it('should count tokens in a string', () => {
    const count = countTokens('Hello world');
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it('should return 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });
});

describe('formatTokenCount', () => {
  it('should format millions', () => {
    expect(formatTokenCount(1_200_000)).toBe('~1.2M');
    expect(formatTokenCount(2_500_000)).toBe('~2.5M');
  });

  it('should format thousands', () => {
    expect(formatTokenCount(340_000)).toBe('~340K');
    expect(formatTokenCount(1_500)).toBe('~2K');
  });

  it('should format small numbers', () => {
    expect(formatTokenCount(500)).toBe('~500');
    expect(formatTokenCount(0)).toBe('~0');
  });
});

describe('loadTasks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-est-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return empty array when tasks directory does not exist', () => {
    const tasks = loadTasks(tempDir);
    expect(tasks).toEqual([]);
  });

  it('should load task files from tasks directory', () => {
    const tasksDir = join(tempDir, '.anatoly', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, 'src-index.task.json'),
      JSON.stringify({
        version: 1,
        file: 'src/index.ts',
        hash: 'abc123',
        symbols: [{ name: 'main', kind: 'function', exported: true, line_start: 1, line_end: 5 }],
        scanned_at: '2026-01-01T00:00:00Z',
      }),
    );

    const tasks = loadTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].file).toBe('src/index.ts');
  });
});

describe('estimateFileSeconds', () => {
  it('should return BASE_SECONDS for 0 symbols', () => {
    expect(estimateFileSeconds(0)).toBe(BASE_SECONDS);
  });

  it('should scale with symbol count', () => {
    // 5 symbols: 4 + 5 × 0.8 = 8s
    expect(estimateFileSeconds(5)).toBe(BASE_SECONDS + 5 * SECONDS_PER_SYMBOL);
    expect(estimateFileSeconds(5)).toBeCloseTo(8);
  });

  it('should estimate more time for files with many symbols', () => {
    // 20 symbols: 4 + 20 × 0.8 = 20s
    expect(estimateFileSeconds(20)).toBeCloseTo(20);
  });
});

describe('constants', () => {
  it('should have expected values', () => {
    expect(BASE_SECONDS).toBe(4);
    expect(SECONDS_PER_SYMBOL).toBe(0.8);
  });
});
