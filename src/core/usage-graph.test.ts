import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUsageGraph, getSymbolUsage } from './usage-graph.js';
import type { Task } from '../schemas/task.js';

function makeTask(file: string, symbols: Array<{ name: string; exported: boolean; kind?: string }>): Task {
  return {
    version: 1,
    file,
    hash: 'abc123',
    symbols: symbols.map((s, i) => ({
      name: s.name,
      kind: (s.kind ?? 'function') as Task['symbols'][0]['kind'],
      exported: s.exported,
      line_start: i * 10 + 1,
      line_end: i * 10 + 10,
    })),
    scanned_at: new Date().toISOString(),
  };
}

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `anatoly-ug-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Helper: create a file in testDir and return the relative path */
function createFile(relPath: string, content: string): void {
  const absPath = join(testDir, relPath);
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content);
}

describe('buildUsageGraph', () => {
  it('tracks named imports', () => {
    createFile('src/utils/cache.ts', 'export function computeHash() {}\nexport function readProgress() {}\n');
    createFile('src/core/scanner.ts', "import { computeHash, readProgress } from '../utils/cache.js';\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [
        { name: 'computeHash', exported: true },
        { name: 'readProgress', exported: true },
      ]),
      makeTask('src/core/scanner.ts', [
        { name: 'scanProject', exported: true },
      ]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual(['src/core/scanner.ts']);
    expect(getSymbolUsage(graph, 'readProgress', 'src/utils/cache.ts')).toEqual(['src/core/scanner.ts']);
  });

  it('tracks named imports with aliases (as)', () => {
    createFile('src/utils/format.ts', 'export function bold() {}\n');
    createFile('src/core/reporter.ts', "import { bold as makeBold } from '../utils/format.js';\n");

    const tasks = [
      makeTask('src/utils/format.ts', [{ name: 'bold', exported: true }]),
      makeTask('src/core/reporter.ts', [{ name: 'generateReport', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    // Tracks the original name 'bold', not the alias
    expect(getSymbolUsage(graph, 'bold', 'src/utils/format.ts')).toEqual(['src/core/reporter.ts']);
  });

  it('tracks default imports', () => {
    createFile('src/utils/format.ts', 'export default function format() {}\n');
    createFile('src/core/reporter.ts', "import format from '../utils/format.js';\n");

    const tasks = [
      makeTask('src/utils/format.ts', [{ name: 'format', exported: true }]),
      makeTask('src/core/reporter.ts', [{ name: 'generateReport', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'default', 'src/utils/format.ts')).toEqual(['src/core/reporter.ts']);
  });

  it('tracks namespace imports — all exports marked used', () => {
    createFile('src/schemas/review.ts', 'export const A = 1;\nexport const B = 2;\n');
    createFile('src/core/reviewer.ts', "import * as Review from '../schemas/review.js';\n");

    const tasks = [
      makeTask('src/schemas/review.ts', [
        { name: 'A', exported: true, kind: 'constant' },
        { name: 'B', exported: true, kind: 'constant' },
      ]),
      makeTask('src/core/reviewer.ts', [{ name: 'reviewFile', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'A', 'src/schemas/review.ts')).toEqual(['src/core/reviewer.ts']);
    expect(getSymbolUsage(graph, 'B', 'src/schemas/review.ts')).toEqual(['src/core/reviewer.ts']);
  });

  it('tracks re-exports', () => {
    createFile('src/utils/cache.ts', 'export function computeHash() {}\n');
    createFile('src/utils/index.ts', "export { computeHash } from './cache.js';\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [{ name: 'computeHash', exported: true }]),
      makeTask('src/utils/index.ts', []),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual(['src/utils/index.ts']);
  });

  it('ignores node_modules imports', () => {
    createFile('src/core/scanner.ts', "import { readFileSync } from 'node:fs';\nimport chalk from 'chalk';\n");

    const tasks = [
      makeTask('src/core/scanner.ts', [{ name: 'scanProject', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    // No entries for node:fs or chalk
    expect(graph.usages.size).toBe(0);
  });

  it('resolves .js → .ts in ESM imports', () => {
    createFile('src/utils/cache.ts', 'export function computeHash() {}\n');
    createFile('src/core/scanner.ts', "import { computeHash } from '../utils/cache.js';\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [{ name: 'computeHash', exported: true }]),
      makeTask('src/core/scanner.ts', [{ name: 'scanProject', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual(['src/core/scanner.ts']);
  });

  it('resolves bare path to /index.ts', () => {
    mkdirSync(join(testDir, 'src/commands'), { recursive: true });
    createFile('src/commands/index.ts', 'export function registerScan() {}\n');
    createFile('src/cli.ts', "import { registerScan } from './commands/index.js';\n");

    // Also test the "directory" resolution
    createFile('src/app.ts', "import { registerScan } from './commands';\n");

    const tasks = [
      makeTask('src/commands/index.ts', [{ name: 'registerScan', exported: true }]),
      makeTask('src/cli.ts', [{ name: 'createProgram', exported: true }]),
      makeTask('src/app.ts', [{ name: 'main', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    const importers = getSymbolUsage(graph, 'registerScan', 'src/commands/index.ts');
    expect(importers).toContain('src/cli.ts');
    expect(importers).toContain('src/app.ts');
  });

  it('tracks multiple importers for a single symbol', () => {
    createFile('src/utils/cache.ts', 'export function computeHash() {}\n');
    createFile('src/core/scanner.ts', "import { computeHash } from '../utils/cache.js';\n");
    createFile('src/core/reviewer.ts', "import { computeHash } from '../utils/cache.js';\n");
    createFile('src/commands/run.ts', "import { computeHash } from '../utils/cache.js';\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [{ name: 'computeHash', exported: true }]),
      makeTask('src/core/scanner.ts', [{ name: 'scanProject', exported: true }]),
      makeTask('src/core/reviewer.ts', [{ name: 'reviewFile', exported: true }]),
      makeTask('src/commands/run.ts', [{ name: 'runCommand', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    const importers = getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts');
    expect(importers).toHaveLength(3);
    expect(importers).toContain('src/core/scanner.ts');
    expect(importers).toContain('src/core/reviewer.ts');
    expect(importers).toContain('src/commands/run.ts');
  });

  it('returns empty array for unused symbol', () => {
    createFile('src/utils/cache.ts', 'export function unused() {}\n');

    const tasks = [
      makeTask('src/utils/cache.ts', [{ name: 'unused', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'unused', 'src/utils/cache.ts')).toEqual([]);
  });

  it('ignores type-only imports', () => {
    createFile('src/schemas/task.ts', 'export type Task = { file: string };\n');
    createFile('src/core/scanner.ts', "import type { Task } from '../schemas/task.js';\n");

    const tasks = [
      makeTask('src/schemas/task.ts', [{ name: 'Task', exported: true, kind: 'type' }]),
      makeTask('src/core/scanner.ts', [{ name: 'scanProject', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    // type-only imports should not count as runtime usage
    expect(getSymbolUsage(graph, 'Task', 'src/schemas/task.ts')).toEqual([]);
  });

  it('does not count self-imports', () => {
    createFile('src/utils/cache.ts', "import { computeHash } from './cache.js';\nexport function computeHash() {}\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [{ name: 'computeHash', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual([]);
  });
});

describe('getSymbolUsage', () => {
  it('returns sorted list of importers', () => {
    createFile('src/a.ts', 'export const X = 1;\n');
    createFile('src/c.ts', "import { X } from './a.js';\n");
    createFile('src/b.ts', "import { X } from './a.js';\n");

    const tasks = [
      makeTask('src/a.ts', [{ name: 'X', exported: true, kind: 'constant' }]),
      makeTask('src/c.ts', [{ name: 'Y', exported: false, kind: 'constant' }]),
      makeTask('src/b.ts', [{ name: 'Z', exported: false, kind: 'constant' }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    // Should be sorted alphabetically
    expect(getSymbolUsage(graph, 'X', 'src/a.ts')).toEqual(['src/b.ts', 'src/c.ts']);
  });
});
