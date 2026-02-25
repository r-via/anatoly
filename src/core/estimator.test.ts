import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  estimateProject,
  loadTasks,
  countTokens,
  formatTokenCount,
  estimateFileSeconds,
  estimateSequentialSeconds,
  estimateMinutesWithConcurrency,
  BASE_SECONDS,
  SECONDS_PER_SYMBOL,
  CONCURRENCY_EFFICIENCY,
  AXIS_COUNT,
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

describe('estimateProject', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-est2-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return zeros when no tasks exist', () => {
    const result = estimateProject(tempDir);
    expect(result.files).toBe(0);
    expect(result.symbols).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedMinutes).toBe(0);
    expect(result.estimatedCalls).toBe(0);
  });

  it('should estimate tokens from task files and source content', () => {
    // Create source file
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'index.ts'),
      `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
    );

    // Create task file
    const tasksDir = join(tempDir, '.anatoly', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, 'src-index.task.json'),
      JSON.stringify({
        version: 1,
        file: 'src/index.ts',
        hash: 'abc',
        symbols: [
          { name: 'greet', kind: 'function', exported: true, line_start: 1, line_end: 3 },
        ],
        scanned_at: '2026-01-01T00:00:00Z',
      }),
    );

    const result = estimateProject(tempDir);
    expect(result.files).toBe(1);
    expect(result.symbols).toBe(1);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.estimatedMinutes).toBeGreaterThan(0);
    expect(result.estimatedCalls).toBe(AXIS_COUNT); // 6 axes per file
  });

  it('should handle deleted source files gracefully', () => {
    // Task without corresponding source file
    const tasksDir = join(tempDir, '.anatoly', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, 'src-deleted.task.json'),
      JSON.stringify({
        version: 1,
        file: 'src/deleted.ts',
        hash: 'abc',
        symbols: [
          { name: 'foo', kind: 'function', exported: true, line_start: 1, line_end: 10 },
        ],
        scanned_at: '2026-01-01T00:00:00Z',
      }),
    );

    const result = estimateProject(tempDir);
    expect(result.files).toBe(1);
    expect(result.inputTokens).toBeGreaterThan(0);
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

describe('estimateSequentialSeconds', () => {
  it('should return 0 for empty task list', () => {
    expect(estimateSequentialSeconds([])).toBe(0);
  });

  it('should sum weighted seconds across tasks', () => {
    const tasks = [
      { file: 'a.ts', symbols: new Array(5) },
      { file: 'b.ts', symbols: new Array(10) },
    ] as { file: string; symbols: unknown[] }[];
    // a: 4 + 5×0.8 = 8, b: 4 + 10×0.8 = 12 → total 20
    const result = estimateSequentialSeconds(tasks as import('../schemas/task.js').Task[]);
    expect(result).toBeCloseTo(20);
  });
});

describe('estimateMinutesWithConcurrency', () => {
  it('should return 0 for 0 seconds', () => {
    expect(estimateMinutesWithConcurrency(0, 3)).toBe(0);
  });

  it('should ceil to minutes for sequential (concurrency 1)', () => {
    // 80s sequential → ceil(80/60) = 2 min
    expect(estimateMinutesWithConcurrency(80, 1)).toBe(2);
  });

  it('should apply concurrency efficiency factor', () => {
    // 120s / (3 × 0.75) = 120 / 2.25 = 53.3s → ceil(53.3/60) = 1 min
    expect(estimateMinutesWithConcurrency(120, 3)).toBe(1);
  });

  it('should not over-discount with high concurrency', () => {
    // 600s / (5 × 0.75) = 600 / 3.75 = 160s → ceil(160/60) = 3 min
    expect(estimateMinutesWithConcurrency(600, 5)).toBe(3);
  });
});

describe('constants', () => {
  it('should have expected values', () => {
    expect(BASE_SECONDS).toBe(4);
    expect(SECONDS_PER_SYMBOL).toBe(0.8);
    expect(CONCURRENCY_EFFICIENCY).toBe(0.75);
    expect(AXIS_COUNT).toBe(6);
  });
});
