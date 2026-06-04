// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUsageGraph, getSymbolUsage, getTypeOnlySymbolUsage } from './usage-graph.js';
import { detectTsPathAliases, resolveAliasCandidates } from './ts-path-aliases.js';
import type { Task } from '../../schemas/task.js';

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

  it('tracks star re-exports — all exports marked used', () => {
    createFile('src/utils/cache.ts', 'export function computeHash() {}\nexport function readProgress() {}\n');
    createFile('src/utils/index.ts', "export * from './cache.js';\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [
        { name: 'computeHash', exported: true },
        { name: 'readProgress', exported: true },
      ]),
      makeTask('src/utils/index.ts', []),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual(['src/utils/index.ts']);
    expect(getSymbolUsage(graph, 'readProgress', 'src/utils/cache.ts')).toEqual(['src/utils/index.ts']);
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

  it('tracks type-only imports separately from runtime imports', () => {
    createFile('src/schemas/task.ts', 'export type Task = { file: string };\n');
    createFile('src/core/scanner.ts', "import type { Task } from '../schemas/task.js';\n");

    const tasks = [
      makeTask('src/schemas/task.ts', [{ name: 'Task', exported: true, kind: 'type' }]),
      makeTask('src/core/scanner.ts', [{ name: 'scanProject', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    // type-only imports should NOT count as runtime usage
    expect(getSymbolUsage(graph, 'Task', 'src/schemas/task.ts')).toEqual([]);
    // but they should be tracked in typeOnlyUsages
    expect(getTypeOnlySymbolUsage(graph, 'Task', 'src/schemas/task.ts')).toEqual(['src/core/scanner.ts']);
  });

  it('tracks an inline type specifier in a mixed named import (import { x, type Y })', () => {
    createFile('src/rag/prefetch.ts', 'export function prefetch() {}\nexport type Progress = { pct: number };\n');
    createFile('src/cli/setup.ts', "import { prefetch, type Progress } from '../rag/prefetch.js';\n");

    const tasks = [
      makeTask('src/rag/prefetch.ts', [{ name: 'prefetch', exported: true }, { name: 'Progress', exported: true, kind: 'type' }]),
      makeTask('src/cli/setup.ts', [{ name: 'run', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'prefetch', 'src/rag/prefetch.ts')).toEqual(['src/cli/setup.ts']);
    // `type Progress` must resolve to symbol `Progress` (not `type Progress`),
    // tracked as a type-only importer — this is the bug that flagged it DEAD.
    expect(getTypeOnlySymbolUsage(graph, 'Progress', 'src/rag/prefetch.ts')).toEqual(['src/cli/setup.ts']);
  });

  it("tracks an inline import-type query (import('./path').Type)", () => {
    createFile('src/schemas/review.ts', 'export type DocsCoverage = { pct: number };\n');
    createFile('src/core/merger.ts', "function f(x?: import('../schemas/review.js').DocsCoverage) { return x; }\n");

    const tasks = [
      makeTask('src/schemas/review.ts', [{ name: 'DocsCoverage', exported: true, kind: 'type' }]),
      makeTask('src/core/merger.ts', [{ name: 'f', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getTypeOnlySymbolUsage(graph, 'DocsCoverage', 'src/schemas/review.ts')).toEqual(['src/core/merger.ts']);
  });

  it('does not count self-imports', () => {
    createFile('src/utils/cache.ts', "import { computeHash } from './cache.js';\nexport function computeHash() {}\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [{ name: 'computeHash', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual([]);
  });

  it('importerOnlyTasks: test-only imports keep audit symbols USED', () => {
    // Symbol is exported from src/, used ONLY by a test file. Without the
    // importer-only superset it would show as DEAD because tests are excluded
    // from the audit task set.
    createFile('src/utils/cache.ts', 'export function computeHash() {}\n');
    createFile('tests/cache.test.ts', "import { computeHash } from '../src/utils/cache.js';\n");

    const auditTasks = [
      makeTask('src/utils/cache.ts', [{ name: 'computeHash', exported: true }]),
    ];
    const importerOnlyTasks = [
      makeTask('tests/cache.test.ts', []),
    ];

    const graph = buildUsageGraph(testDir, auditTasks, importerOnlyTasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual(['tests/cache.test.ts']);
  });

  it('importerOnlyTasks: namespace-import re-exports stay scoped to audit exports', () => {
    // Audit file `src/schemas/review.ts` exports A; test file does a star
    // import on it. Without the importer-only feed, A would be DEAD. The
    // namespace-import resolution must use the audit export map (A is there),
    // not anything contributed by importer-only tasks, so the edge for A
    // points at the test file as importer.
    createFile('src/schemas/review.ts', 'export const A = 1;\n');
    createFile('tests/review.test.ts', "import * as Review from '../src/schemas/review.js';\n");

    const auditTasks = [
      makeTask('src/schemas/review.ts', [{ name: 'A', exported: true, kind: 'constant' }]),
    ];
    const importerOnlyTasks = [
      makeTask('tests/review.test.ts', []),
    ];

    const graph = buildUsageGraph(testDir, auditTasks, importerOnlyTasks);
    expect(getSymbolUsage(graph, 'A', 'src/schemas/review.ts')).toEqual(['tests/review.test.ts']);
  });
});

// --- Story 31.13: Multi-Language Usage Graph ---

describe('buildUsageGraph — multi-language', () => {
  // AC 31.13.1: Bash source edge
  it('AC 31.13.1: tracks bash source imports', () => {
    createFile('scripts/setup.sh', 'source ./lib/helpers.sh\necho "setup"\nline3\nline4\nline5\n');
    createFile('scripts/lib/helpers.sh', 'function helper() { echo "help"; }\nline2\nline3\nline4\nline5\n');

    const tasks = [
      { ...makeTask('scripts/setup.sh', [{ name: 'setup', exported: true }]), language: 'bash' } as Task,
      { ...makeTask('scripts/lib/helpers.sh', [{ name: 'helper', exported: true }]), language: 'bash' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'helper', 'scripts/lib/helpers.sh')).toEqual(['scripts/setup.sh']);
  });

  // AC 31.13.2: .sh file not sourced → candidate for DEAD
  it('AC 31.13.2: unsourced sh file has zero importers', () => {
    createFile('scripts/unused.sh', 'function unused() { echo "never"; }\nline2\nline3\nline4\nline5\n');

    const tasks = [
      { ...makeTask('scripts/unused.sh', [{ name: 'unused', exported: true }]), language: 'bash' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'unused', 'scripts/unused.sh')).toEqual([]);
  });

  // AC 31.13.3: Python from...import edge
  it('AC 31.13.3: tracks python import edges', () => {
    createFile('src/helpers.py', 'def format_output(): pass\nline2\nline3\nline4\nline5\n');
    createFile('src/main.py', 'from helpers import format_output\nprint(format_output())\nline3\nline4\nline5\n');

    const tasks = [
      { ...makeTask('src/helpers.py', [{ name: 'format_output', exported: true }]), language: 'python' } as Task,
      { ...makeTask('src/main.py', [{ name: 'main', exported: true }]), language: 'python' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'format_output', 'src/helpers.py')).toEqual(['src/main.py']);
  });

  // Python src-layout: absolute import (`from pkg.mod import x`) resolves
  // through pyproject.toml-declared source roots, not just importer-relative.
  // Regression guard: the bench on anselms-journey (src-layout) reported
  // every Python export as "0 importers" because the resolver only tried
  // importer-relative and project-root.
  it('python src-layout: absolute imports resolve through pyproject source roots', () => {
    createFile('pyproject.toml', '[tool.setuptools.packages.find]\nwhere = ["src"]\n');
    createFile('src/open_saga/scaffold.py', 'def universal_slots(): pass\nSCAFFOLD_SCHEMA_VERSION = 1\nline3\nline4\nline5\n');
    createFile(
      'src/open_saga/outliner.py',
      'from open_saga.scaffold import universal_slots, SCAFFOLD_SCHEMA_VERSION\nuniversal_slots()\nline3\nline4\nline5\n',
    );

    const tasks = [
      { ...makeTask('src/open_saga/scaffold.py', [
        { name: 'universal_slots', exported: true },
        { name: 'SCAFFOLD_SCHEMA_VERSION', exported: true, kind: 'constant' },
      ]), language: 'python' } as Task,
      { ...makeTask('src/open_saga/outliner.py', [
        { name: 'main', exported: true },
      ]), language: 'python' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'universal_slots', 'src/open_saga/scaffold.py')).toEqual(['src/open_saga/outliner.py']);
    expect(getSymbolUsage(graph, 'SCAFFOLD_SCHEMA_VERSION', 'src/open_saga/scaffold.py')).toEqual(['src/open_saga/outliner.py']);
  });

  // src-layout heuristic: even without pyproject.toml, a `src/` directory
  // is enough to opt into src-layout resolution.
  it('python src-layout: falls back to src/ heuristic when pyproject.toml is missing', () => {
    createFile('src/pkg/foo.py', 'def helper(): pass\nline2\nline3\nline4\nline5\n');
    createFile(
      'src/pkg/bar.py',
      'from pkg.foo import helper\nhelper()\nline3\nline4\nline5\n',
    );

    const tasks = [
      { ...makeTask('src/pkg/foo.py', [{ name: 'helper', exported: true }]), language: 'python' } as Task,
      { ...makeTask('src/pkg/bar.py', [{ name: 'main', exported: true }]), language: 'python' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'helper', 'src/pkg/foo.py')).toEqual(['src/pkg/bar.py']);
  });

  // poetry layout: `packages = [{include = "pkg", from = "src"}]`
  it('python src-layout: parses poetry packages[].from', () => {
    createFile(
      'pyproject.toml',
      '[tool.poetry]\nname = "demo"\npackages = [{include = "demo", from = "lib"}]\n',
    );
    createFile('lib/demo/util.py', 'def shared(): pass\nline2\nline3\nline4\nline5\n');
    createFile(
      'lib/demo/main.py',
      'from demo.util import shared\nshared()\nline3\nline4\nline5\n',
    );

    const tasks = [
      { ...makeTask('lib/demo/util.py', [{ name: 'shared', exported: true }]), language: 'python' } as Task,
      { ...makeTask('lib/demo/main.py', [{ name: 'main', exported: true }]), language: 'python' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'shared', 'lib/demo/util.py')).toEqual(['lib/demo/main.py']);
  });

  // AC 31.13.4: Rust use crate edge
  it('AC 31.13.4: tracks rust crate import edges', () => {
    createFile('src/scanner.rs', 'pub fn parse() {}\nline2\nline3\nline4\nline5\n');
    createFile('src/main.rs', 'use crate::scanner::parse;\nfn main() { parse(); }\nline3\nline4\nline5\n');

    const tasks = [
      { ...makeTask('src/scanner.rs', [{ name: 'parse', exported: true }]), language: 'rust' } as Task,
      { ...makeTask('src/main.rs', [{ name: 'main', exported: true }]), language: 'rust' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'parse', 'src/scanner.rs')).toEqual(['src/main.rs']);
  });

  // AC 31.13.5: YAML → no edges, not dead
  it('AC 31.13.5: creates no edges for YAML files', () => {
    createFile('docker-compose.yml', 'services:\n  api:\n    image: node:20\nvolumes:\n  data:\n');

    const tasks = [
      { ...makeTask('docker-compose.yml', [{ name: 'services', exported: true, kind: 'variable' }]), language: 'yaml' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(graph.usages.size).toBe(0);
    expect(graph.noImportFiles.has('docker-compose.yml')).toBe(true);
  });

  // AC 31.13.6: TypeScript unchanged (zero regression)
  it('AC 31.13.6: keeps TypeScript imports unchanged', () => {
    createFile('src/utils/cache.ts', 'export function computeHash() {}\n');
    createFile('src/core/scanner.ts', "import { computeHash } from '../utils/cache.js';\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [{ name: 'computeHash', exported: true }]),
      makeTask('src/core/scanner.ts', [{ name: 'scanProject', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual(['src/core/scanner.ts']);
  });

  // JSON and SQL are also no-import-system
  it('marks JSON and SQL as no-import-system files', () => {
    createFile('config.json', '{"name": "test"}\n');
    createFile('schema.sql', 'CREATE TABLE users (id INT);\nSELECT 1;\nSELECT 2;\nSELECT 3;\nSELECT 4;\n');

    const tasks = [
      { ...makeTask('config.json', [{ name: 'name', exported: true, kind: 'variable' }]), language: 'json' } as Task,
      { ...makeTask('schema.sql', [{ name: 'users', exported: true, kind: 'class' }]), language: 'sql' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(graph.noImportFiles.has('config.json')).toBe(true);
    expect(graph.noImportFiles.has('schema.sql')).toBe(true);
  });
});

describe('buildUsageGraph — TypeScript path aliases', () => {
  it('resolves an aliased import (@/*) so the target is not falsely DEAD', () => {
    createFile('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    createFile('src/lib/api.ts', 'export function fetchData() {}\n');
    createFile('src/pages/Home.tsx', "import { fetchData } from '@/lib/api';\n");

    const tasks = [
      makeTask('src/lib/api.ts', [{ name: 'fetchData', exported: true }]),
      makeTask('src/pages/Home.tsx', [{ name: 'Home', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'fetchData', 'src/lib/api.ts')).toEqual(['src/pages/Home.tsx']);
  });

  it('handles baseUrl at root with code under client/src (the Vite trap)', () => {
    // tsconfig at root: baseUrl '.', paths map @/ to client/src, but the code
    // lives under client/src — the alias base must come from baseUrl, not the
    // auto-detected source root, otherwise the prefix doubles.
    createFile('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['client/src/*'] } },
      include: ['client/src'],
    }));
    createFile('client/src/lib/api.ts', 'export function getPatients() {}\n');
    createFile('client/src/components/AppLayout.tsx', "import { getPatients } from '@/lib/api';\n");

    const tasks = [
      makeTask('client/src/lib/api.ts', [{ name: 'getPatients', exported: true }]),
      makeTask('client/src/components/AppLayout.tsx', [{ name: 'AppLayout', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'getPatients', 'client/src/lib/api.ts'))
      .toEqual(['client/src/components/AppLayout.tsx']);
  });

  it('resolves an aliased index barrel (@/components → @/components/index.ts)', () => {
    createFile('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    createFile('src/components/index.ts', 'export function Button() {}\n');
    createFile('src/App.tsx', "import { Button } from '@/components';\n");

    const tasks = [
      makeTask('src/components/index.ts', [{ name: 'Button', exported: true }]),
      makeTask('src/App.tsx', [{ name: 'App', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'Button', 'src/components/index.ts')).toEqual(['src/App.tsx']);
  });

  it('resolves a non-wildcard exact alias pointing at a file', () => {
    createFile('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@config': ['src/config/env.ts'] } },
    }));
    createFile('src/config/env.ts', 'export const ENV = "prod";\n');
    createFile('src/main.ts', "import { ENV } from '@config';\n");

    const tasks = [
      makeTask('src/config/env.ts', [{ name: 'ENV', exported: true, kind: 'constant' }]),
      makeTask('src/main.ts', [{ name: 'main', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'ENV', 'src/config/env.ts')).toEqual(['src/main.ts']);
  });

  it('reads aliases from a referenced tsconfig.app.json (Vite scaffold split)', () => {
    createFile('tsconfig.json', JSON.stringify({
      references: [{ path: './tsconfig.app.json' }],
    }));
    createFile('tsconfig.app.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    createFile('src/lib/api.ts', 'export function fetchData() {}\n');
    createFile('src/pages/Home.tsx', "import { fetchData } from '@/lib/api';\n");

    const tasks = [
      makeTask('src/lib/api.ts', [{ name: 'fetchData', exported: true }]),
      makeTask('src/pages/Home.tsx', [{ name: 'Home', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'fetchData', 'src/lib/api.ts')).toEqual(['src/pages/Home.tsx']);
  });

  it('does not resolve bare node_modules specifiers as aliases', () => {
    createFile('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    createFile('src/a.ts', 'export const X = 1;\n');
    // A bare import that shares no alias prefix must stay unresolved (no crash).
    createFile('src/b.ts', "import { useState } from 'react';\nimport { X } from '@/a';\n");

    const tasks = [
      makeTask('src/a.ts', [{ name: 'X', exported: true, kind: 'constant' }]),
      makeTask('src/b.ts', [{ name: 'B', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    // The alias import is tracked; the bare 'react' import contributes nothing.
    expect(getSymbolUsage(graph, 'X', 'src/a.ts')).toEqual(['src/b.ts']);
  });

  it('still resolves relative imports when an alias map is present', () => {
    createFile('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    createFile('src/utils/cache.ts', 'export function computeHash() {}\n');
    createFile('src/core/scanner.ts', "import { computeHash } from '../utils/cache.js';\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [{ name: 'computeHash', exported: true }]),
      makeTask('src/core/scanner.ts', [{ name: 'scanProject', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual(['src/core/scanner.ts']);
  });
});

describe('detectTsPathAliases', () => {
  it('returns an empty list when no tsconfig is present', () => {
    expect(detectTsPathAliases(testDir)).toEqual([]);
  });

  it('tolerates JSONC comments and trailing commas', () => {
    createFile('tsconfig.json', [
      '{',
      '  // project config',
      '  "compilerOptions": {',
      '    "baseUrl": ".", /* root */',
      '    "paths": { "@/*": ["src/*"], }',
      '  },',
      '}',
    ].join('\n'));

    const aliases = detectTsPathAliases(testDir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]!.prefix).toBe('@/');
    expect(aliases[0]!.wildcard).toBe(true);

    const candidates = resolveAliasCandidates('@/lib/api', aliases);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.endsWith('/src/lib/api')).toBe(true);
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
