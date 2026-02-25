import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { estimateProject, loadTasks, countTokens, formatTokenCount, estimateTriagedMinutes, SECONDS_PER_TIER, AXIS_COUNT } from './estimator.js';

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

describe('estimateTriagedMinutes', () => {
  it('should return 0 for all skip', () => {
    expect(estimateTriagedMinutes({ skip: 10, evaluate: 0 })).toBe(0);
  });

  it('should estimate time for evaluate tier', () => {
    // 10 files × 8s = 80s → Math.ceil(80/60) = 2 min
    expect(estimateTriagedMinutes({ skip: 0, evaluate: 10 })).toBe(2);
  });

  it('should combine skip and evaluate', () => {
    // 5 skip × 0s + 5 evaluate × 8s = 40s → Math.ceil(40/60) = 1 min
    expect(estimateTriagedMinutes({ skip: 5, evaluate: 5 })).toBe(1);
  });
});

describe('SECONDS_PER_TIER', () => {
  it('should have skip at 0 and evaluate at 8', () => {
    expect(SECONDS_PER_TIER.skip).toBe(0);
    expect(SECONDS_PER_TIER.evaluate).toBe(8);
  });
});
