// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile } from './scanner.js';
import {
  buildUsageGraph,
  getSymbolUsage,
  getTypeOnlySymbolUsage,
  getImportedSymbolsBySource,
  getTransitiveImporters,
  resolveExportedSymbolUtility,
  resolveNonExportedSymbolUtility,
  stripTemplateLiterals,
  type UsageGraph,
} from './usage-graph.js';
import { detectTsPathAliases, resolveAliasCandidates } from './ts-path-aliases.js';
import type { Task } from '../../schemas/task.js';

function makeTask(
  file: string,
  symbols: Array<{ name: string; exported: boolean; kind?: string; is_default?: boolean }>,
): Task {
  return {
    version: 1,
    file,
    hash: 'abc123',
    symbols: symbols.map((s, i) => ({
      name: s.name,
      kind: (s.kind ?? 'function') as Task['symbols'][0]['kind'],
      exported: s.exported,
      ...(s.is_default ? { is_default: true } : {}),
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

/**
 * Build the usage graph the way the real pipeline does: parse each TS task's
 * on-disk file to populate symbol-level (enriched) `task.imports`, then build.
 * Use this for tests that assert fine-grained edges (default / type-only /
 * namespace / re-export). Tests that do not enrich exercise the coarse
 * module-level fallback instead.
 */
async function graphOf(tasks: Task[], importerTasks: Task[] = []): Promise<UsageGraph> {
  for (const t of [...tasks, ...importerTasks]) {
    const e = extname(t.file);
    if (e !== '.ts' && e !== '.tsx') continue;
    try {
      const r = await parseFile(t.file, readFileSync(join(testDir, t.file), 'utf-8'));
      if (r.imports.length > 0) t.imports = r.imports;
      if (r.importsEnriched) t.imports_enriched = true;
    } catch { /* task may have no on-disk file */ }
  }
  return buildUsageGraph(testDir, tasks, importerTasks);
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

  it('bridges a default-exported React component to its declared name (JSX wiring recognizer)', async () => {
    // A default import is keyed under the synthetic name `default`; the React
    // wiring recognizer re-keys it under the component's declared name, where
    // flow's resolveDead / the utility axis look it up — so `<Auth/>` pages are
    // no longer false-DEAD / unwired.
    createFile('src/pages/Auth.tsx', 'export default function Auth() { return null; }\n');
    createFile('src/App.tsx', "import Auth from './pages/Auth';\nexport default function App() { return <Auth/>; }\n");

    const tasks = [
      makeTask('src/pages/Auth.tsx', [{ name: 'Auth', exported: true, is_default: true }]),
      makeTask('src/App.tsx', [{ name: 'App', exported: true, is_default: true }]),
    ];

    const graph = await graphOf(tasks);
    // The synthetic `default` edge still exists; the bridge ADDS the declared name.
    expect(getSymbolUsage(graph, 'Auth', 'src/pages/Auth.tsx')).toContain('src/App.tsx');
  });

  it('does NOT bridge default imports in a plain .ts (non-JSX) codebase', async () => {
    createFile('src/utils/format.ts', 'export default function format() {}\n');
    createFile('src/core/reporter.ts', "import format from '../utils/format.js';\n");

    const tasks = [
      makeTask('src/utils/format.ts', [{ name: 'format', exported: true, is_default: true }]),
      makeTask('src/core/reporter.ts', [{ name: 'generateReport', exported: true }]),
    ];

    const graph = await graphOf(tasks);
    // No JSX, no React framework → recognizer inert; only the `default` key holds the edge.
    expect(getSymbolUsage(graph, 'format', 'src/utils/format.ts')).toEqual([]);
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

  it('tracks default imports', async () => {
    createFile('src/utils/format.ts', 'export default function format() {}\n');
    createFile('src/core/reporter.ts', "import format from '../utils/format.js';\n");

    const tasks = [
      makeTask('src/utils/format.ts', [{ name: 'format', exported: true }]),
      makeTask('src/core/reporter.ts', [{ name: 'generateReport', exported: true }]),
    ];

    const graph = await graphOf(tasks);
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

  it('tracks re-exports', async () => {
    createFile('src/utils/cache.ts', 'export function computeHash() {}\n');
    createFile('src/utils/index.ts', "export { computeHash } from './cache.js';\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [{ name: 'computeHash', exported: true }]),
      makeTask('src/utils/index.ts', []),
    ];

    const graph = await graphOf(tasks);
    expect(getSymbolUsage(graph, 'computeHash', 'src/utils/cache.ts')).toEqual(['src/utils/index.ts']);
  });

  it('tracks star re-exports — all exports marked used', async () => {
    createFile('src/utils/cache.ts', 'export function computeHash() {}\nexport function readProgress() {}\n');
    createFile('src/utils/index.ts', "export * from './cache.js';\n");

    const tasks = [
      makeTask('src/utils/cache.ts', [
        { name: 'computeHash', exported: true },
        { name: 'readProgress', exported: true },
      ]),
      makeTask('src/utils/index.ts', []),
    ];

    const graph = await graphOf(tasks);
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

  it('tracks type-only imports separately from runtime imports', async () => {
    createFile('src/schemas/task.ts', 'export type Task = { file: string };\n');
    createFile('src/core/scanner.ts', "import type { Task } from '../schemas/task.js';\n");

    const tasks = [
      makeTask('src/schemas/task.ts', [{ name: 'Task', exported: true, kind: 'type' }]),
      makeTask('src/core/scanner.ts', [{ name: 'scanProject', exported: true }]),
    ];

    const graph = await graphOf(tasks);
    // type-only imports should NOT count as runtime usage
    expect(getSymbolUsage(graph, 'Task', 'src/schemas/task.ts')).toEqual([]);
    // but they should be tracked in typeOnlyUsages
    expect(getTypeOnlySymbolUsage(graph, 'Task', 'src/schemas/task.ts')).toEqual(['src/core/scanner.ts']);
  });

  it('tracks an inline type specifier in a mixed named import (import { x, type Y })', async () => {
    createFile('src/rag/prefetch.ts', 'export function prefetch() {}\nexport type Progress = { pct: number };\n');
    createFile('src/cli/setup.ts', "import { prefetch, type Progress } from '../rag/prefetch.js';\n");

    const tasks = [
      makeTask('src/rag/prefetch.ts', [{ name: 'prefetch', exported: true }, { name: 'Progress', exported: true, kind: 'type' }]),
      makeTask('src/cli/setup.ts', [{ name: 'run', exported: true }]),
    ];

    const graph = await graphOf(tasks);
    expect(getSymbolUsage(graph, 'prefetch', 'src/rag/prefetch.ts')).toEqual(['src/cli/setup.ts']);
    // `type Progress` must resolve to symbol `Progress` (not `type Progress`),
    // tracked as a type-only importer — this is the bug that flagged it DEAD.
    expect(getTypeOnlySymbolUsage(graph, 'Progress', 'src/rag/prefetch.ts')).toEqual(['src/cli/setup.ts']);
  });

  it("tracks an inline import-type query (import('./path').Type)", async () => {
    createFile('src/schemas/review.ts', 'export type DocsCoverage = { pct: number };\n');
    createFile('src/core/merger.ts', "function f(x?: import('../schemas/review.js').DocsCoverage) { return x; }\n");

    const tasks = [
      makeTask('src/schemas/review.ts', [{ name: 'DocsCoverage', exported: true, kind: 'type' }]),
      makeTask('src/core/merger.ts', [{ name: 'f', exported: true }]),
    ];

    const graph = await graphOf(tasks);
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

describe('buildUsageGraph — Go package edges', () => {
  // Regression guard: resolveNonTsImportPath had no `.go` branch, so every Go
  // import resolved to null and EVERY exported Go symbol was falsely DEAD
  // (the awf-cli audit: 1943/2214 "0 importers" findings). A Go import is a
  // full module path; it must resolve through go.mod to the package's files.
  function goMod(modulePath = 'example.com/m'): void {
    createFile('go.mod', `module ${modulePath}\n\ngo 1.21\n`);
  }

  it('resolves a cross-package import via the go.mod module path', () => {
    goMod();
    createFile('internal/util/util.go', 'package util\n\nfunc Helper() {}\n');
    createFile(
      'cmd/app/main.go',
      'package main\n\nimport "example.com/m/internal/util"\n\nfunc main() { util.Helper() }\n',
    );

    const tasks = [
      { ...makeTask('internal/util/util.go', [{ name: 'Helper', exported: true }]), language: 'go' } as Task,
      { ...makeTask('cmd/app/main.go', [{ name: 'main', exported: true }]), language: 'go' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'Helper', 'internal/util/util.go')).toEqual(['cmd/app/main.go']);
    // And the DEAD predicate flips to USED for the cross-package consumer.
    expect(
      resolveExportedSymbolUtility({ name: 'Helper', exported: true }, graph, 'internal/util/util.go')?.value,
    ).toBe('USED');
  });

  it('a Go import pulls in the WHOLE package (every file in the directory)', () => {
    goMod();
    // Two files form one package `util`; importing it consumes both.
    createFile('internal/util/a.go', 'package util\n\nfunc Alpha() {}\n');
    createFile('internal/util/b.go', 'package util\n\nfunc Beta() {}\n');
    createFile(
      'cmd/app/main.go',
      'package main\n\nimport (\n\t"fmt"\n\t"example.com/m/internal/util"\n)\n\nfunc main() { util.Alpha(); fmt.Println(1) }\n',
    );

    const tasks = [
      { ...makeTask('internal/util/a.go', [{ name: 'Alpha', exported: true }]), language: 'go' } as Task,
      { ...makeTask('internal/util/b.go', [{ name: 'Beta', exported: true }]), language: 'go' } as Task,
      { ...makeTask('cmd/app/main.go', [{ name: 'main', exported: true }]), language: 'go' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    // Beta is only referenced by main through the package import, never by name.
    // Coarse package expansion (over-mark USED) still keeps it alive.
    expect(getSymbolUsage(graph, 'Alpha', 'internal/util/a.go')).toEqual(['cmd/app/main.go']);
    expect(getSymbolUsage(graph, 'Beta', 'internal/util/b.go')).toEqual(['cmd/app/main.go']);
  });

  it('stdlib / third-party imports create no edge (genuinely unused stays DEAD)', () => {
    goMod();
    createFile('internal/orphan/orphan.go', 'package orphan\n\nfunc Unused() {}\n');
    createFile('cmd/app/main.go', 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println(1) }\n');

    const tasks = [
      { ...makeTask('internal/orphan/orphan.go', [{ name: 'Unused', exported: true }]), language: 'go' } as Task,
      { ...makeTask('cmd/app/main.go', [{ name: 'main', exported: true }]), language: 'go' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    // No project file imports the orphan package → no false USED.
    expect(getSymbolUsage(graph, 'Unused', 'internal/orphan/orphan.go')).toEqual([]);
    expect(
      resolveExportedSymbolUtility({ name: 'Unused', exported: true }, graph, 'internal/orphan/orphan.go')?.value,
    ).toBe('DEAD');
  });

  it('a symbol imported only from a *_test.go (importer-only) is USED, not DEAD', () => {
    goMod();
    // testutil/mocks is consumed only by tests; tests are excluded from the
    // audit set and fed as importer-only tasks. Without the .go resolver +
    // *_test.go importer feed, MockRepo would be falsely DEAD.
    createFile('internal/testutil/mocks/mocks.go', 'package mocks\n\nfunc NewMockRepo() {}\n');
    createFile(
      'internal/app/service_test.go',
      'package app\n\nimport "example.com/m/internal/testutil/mocks"\n\nfunc TestX() { mocks.NewMockRepo() }\n',
    );

    const tasks = [
      { ...makeTask('internal/testutil/mocks/mocks.go', [{ name: 'NewMockRepo', exported: true }]), language: 'go' } as Task,
    ];
    const importerOnly = [
      { ...makeTask('internal/app/service_test.go', [{ name: 'TestX', exported: true }]), language: 'go' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks, importerOnly);
    expect(getSymbolUsage(graph, 'NewMockRepo', 'internal/testutil/mocks/mocks.go')).toEqual([
      'internal/app/service_test.go',
    ]);
    expect(
      resolveExportedSymbolUtility({ name: 'NewMockRepo', exported: true }, graph, 'internal/testutil/mocks/mocks.go')?.value,
    ).toBe('USED');
  });

  it('keeps a same-package helper alive when a sibling file references it (no import)', () => {
    goMod();
    // Go files in one directory share a package and call each other with NO
    // import statement. `helper` (unexported) is used only by sibling caller.go.
    createFile('internal/svc/helper.go', 'package svc\n\nfunc helper() int { return 1 }\n');
    createFile('internal/svc/caller.go', 'package svc\n\nfunc Run() int { return helper() }\n');

    const tasks = [
      { ...makeTask('internal/svc/helper.go', [{ name: 'helper', exported: false }]), language: 'go' } as Task,
      { ...makeTask('internal/svc/caller.go', [{ name: 'Run', exported: true }]), language: 'go' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    // Same-package cross-file edge: helper is consumed by caller.go.
    expect(getSymbolUsage(graph, 'helper', 'internal/svc/helper.go')).toEqual(['internal/svc/caller.go']);
    // And the NON-exported utility verdict must read that edge → USED, not DEAD.
    // (Go unexported = package-scoped; the evaluator must not treat it as file-scoped.)
    expect(
      resolveNonExportedSymbolUtility({ name: 'helper', exported: false }, graph, 'internal/svc/helper.go')?.value,
    ).toBe('USED');
  });

  it('an exported symbol used only within its own package is not DEAD', () => {
    goMod();
    createFile('internal/svc/api.go', 'package svc\n\nfunc Exported() int { return 2 }\n');
    createFile('internal/svc/use.go', 'package svc\n\nfunc internalUse() int { return Exported() }\n');

    const tasks = [
      { ...makeTask('internal/svc/api.go', [{ name: 'Exported', exported: true }]), language: 'go' } as Task,
      { ...makeTask('internal/svc/use.go', [{ name: 'internalUse', exported: false }]), language: 'go' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(
      resolveExportedSymbolUtility({ name: 'Exported', exported: true }, graph, 'internal/svc/api.go')?.value,
    ).toBe('USED');
  });

  it('resolves package paths under a nested go.mod (multi-module layout)', () => {
    goMod('example.com/root');
    // A nested module declares its own path; files beneath it key off it.
    createFile('sub/go.mod', 'module example.com/sub\n\ngo 1.21\n');
    createFile('sub/pkg/lib.go', 'package pkg\n\nfunc Exported() {}\n');
    createFile(
      'sub/cmd/main.go',
      'package main\n\nimport "example.com/sub/pkg"\n\nfunc main() { pkg.Exported() }\n',
    );

    const tasks = [
      { ...makeTask('sub/pkg/lib.go', [{ name: 'Exported', exported: true }]), language: 'go' } as Task,
      { ...makeTask('sub/cmd/main.go', [{ name: 'main', exported: true }]), language: 'go' } as Task,
    ];

    const graph = buildUsageGraph(testDir, tasks);
    expect(getSymbolUsage(graph, 'Exported', 'sub/pkg/lib.go')).toEqual(['sub/cmd/main.go']);
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

describe('buildUsageGraph — default exports', () => {
  it('resolves a default-exported symbol imported via default import (relative)', () => {
    createFile('src/App.tsx', 'export default function App() { return null; }\n');
    createFile('src/main.tsx', "import App from './App';\n");

    const tasks = [
      makeTask('src/App.tsx', [{ name: 'App', exported: true, is_default: true }]),
      makeTask('src/main.tsx', [{ name: 'main', exported: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    const verdict = resolveExportedSymbolUtility(
      { name: 'App', exported: true, is_default: true },
      graph,
      'src/App.tsx',
    );
    expect(verdict?.value).toBe('USED');
  });

  it('still flags the symbol DEAD when is_default is not set (proves the flag matters)', async () => {
    // Plain `.ts` (non-JSX): the React wiring recognizer does not apply here, so
    // this isolates the `is_default` name↔default bridge in
    // resolveExportedSymbolUtility. For `.tsx`/JSX the recognizer bridges the
    // edge regardless of the flag — see the JSX wiring test above.
    createFile('src/server.ts', 'export default function server() { return null; }\n');
    createFile('src/main.ts', "import server from './server';\n");

    const tasks = [
      makeTask('src/server.ts', [{ name: 'server', exported: true }]),
      makeTask('src/main.ts', [{ name: 'main', exported: true }]),
    ];

    const graph = await graphOf(tasks);
    // The importer edge is recorded under `default`, not `server`; without the
    // is_default flag the name-keyed lookup misses it.
    const verdict = resolveExportedSymbolUtility(
      { name: 'server', exported: true },
      graph,
      'src/server.ts',
    );
    expect(verdict?.value).toBe('DEAD');
  });

  it('resolves a default export imported via an aliased default import', () => {
    createFile('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    createFile('src/components/AppLayout.tsx', 'export default function AppLayout() { return null; }\n');
    createFile('src/App.tsx', "import AppLayout from '@/components/AppLayout';\n");

    const tasks = [
      makeTask('src/components/AppLayout.tsx', [{ name: 'AppLayout', exported: true, is_default: true }]),
      makeTask('src/App.tsx', [{ name: 'App', exported: true, is_default: true }]),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    const verdict = resolveExportedSymbolUtility(
      { name: 'AppLayout', exported: true, is_default: true },
      graph,
      'src/components/AppLayout.tsx',
    );
    expect(verdict?.value).toBe('USED');
  });
});

describe('buildUsageGraph — separately default-exported bindings (audio-app utility FP guard)', () => {
  // Build a Task from a REAL parse so the scanner-derived `is_default` flag —
  // not a hand-set one — drives resolution. This is the end-to-end guard for
  // the `const Foo = ...; export default Foo;` form that the scanner used to
  // drop, which mis-flagged used React components (SmartErrorBoundary,
  // SessionInspector, AtmosphereHeroCard) as DEAD.
  async function realTask(relPath: string): Promise<Task> {
    const r = await parseFile(relPath, readFileSync(join(testDir, relPath), 'utf-8'));
    return {
      version: 1,
      file: relPath,
      hash: 'realhash',
      symbols: r.symbols,
      ...(r.imports.length > 0 ? { imports: r.imports } : {}),
      ...(r.importsEnriched ? { imports_enriched: true } : {}),
      scanned_at: new Date().toISOString(),
    };
  }

  it('resolves a const default export consumed via a barrel re-export to USED', async () => {
    createFile(
      'src/components/SessionInspector.tsx',
      'const SessionInspector = () => null;\nexport default SessionInspector;\n',
    );
    createFile(
      'src/components/index.ts',
      "export { default as SessionInspector } from './SessionInspector';\n",
    );
    createFile(
      'src/Bar.tsx',
      "import { SessionInspector } from './components';\nexport function Bar() { return SessionInspector(); }\n",
    );

    const tasks = [
      await realTask('src/components/SessionInspector.tsx'),
      await realTask('src/components/index.ts'),
      await realTask('src/Bar.tsx'),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    const sym = tasks[0].symbols.find((s) => s.name === 'SessionInspector')!;
    expect(sym.is_default).toBe(true); // scanner promoted the separate `export default`
    const verdict = resolveExportedSymbolUtility(sym, graph, 'src/components/SessionInspector.tsx');
    expect(verdict?.value).toBe('USED');
  });

  it('resolves a class default export consumed via a direct default import to USED', async () => {
    createFile(
      'src/SmartErrorBoundary.tsx',
      'class SmartErrorBoundary {}\nexport default SmartErrorBoundary;\n',
    );
    createFile(
      'src/App.tsx',
      "import SmartErrorBoundary from './SmartErrorBoundary';\nexport function App() { return new SmartErrorBoundary(); }\n",
    );

    const tasks = [
      await realTask('src/SmartErrorBoundary.tsx'),
      await realTask('src/App.tsx'),
    ];

    const graph = buildUsageGraph(testDir, tasks);
    const sym = tasks[0].symbols.find((s) => s.name === 'SmartErrorBoundary')!;
    expect(sym.is_default).toBe(true);
    const verdict = resolveExportedSymbolUtility(sym, graph, 'src/SmartErrorBoundary.tsx');
    expect(verdict?.value).toBe('USED');
  });
});

describe('getTransitiveImporters (barrel-aware importer closure)', () => {
  async function realTask(relPath: string): Promise<Task> {
    const r = await parseFile(relPath, readFileSync(join(testDir, relPath), 'utf-8'));
    return {
      version: 1,
      file: relPath,
      hash: 'realhash',
      symbols: r.symbols,
      ...(r.imports.length > 0 ? { imports: r.imports } : {}),
      ...(r.importsEnriched ? { imports_enriched: true } : {}),
      scanned_at: new Date().toISOString(),
    };
  }

  it('follows a barrel re-export to the real consumers (the SyntheticSourceModule FP)', async () => {
    createFile('src/engine/synth.ts', 'export class Synth {}\n');
    createFile('src/engine/index.ts', "export { Synth } from './synth';\n");
    createFile('src/mixer.ts', "import { Synth } from './engine/index';\nexport const m = () => new Synth();\n");
    createFile('src/session.ts', "import { Synth } from './engine/index';\nexport const s = () => new Synth();\n");

    const tasks = [
      await realTask('src/engine/synth.ts'),
      await realTask('src/engine/index.ts'),
      await realTask('src/mixer.ts'),
      await realTask('src/session.ts'),
    ];
    const graph = buildUsageGraph(testDir, tasks);

    // Direct count undercounts (only the barrel); transitive count sees all 3.
    expect(getSymbolUsage(graph, 'Synth', 'src/engine/synth.ts')).toEqual(['src/engine/index.ts']);
    expect(getTransitiveImporters(graph, 'Synth', 'src/engine/synth.ts')).toEqual([
      'src/engine/index.ts',
      'src/mixer.ts',
      'src/session.ts',
    ]);
  });

  it('chases multi-hop barrel chains', async () => {
    createFile('src/a/widget.ts', 'export class Widget {}\n');
    createFile('src/a/index.ts', "export { Widget } from './widget';\n");
    createFile('src/index.ts', "export { Widget } from './a/index';\n");
    createFile('src/app.ts', "import { Widget } from './index';\nexport const go = () => new Widget();\n");

    const tasks = [
      await realTask('src/a/widget.ts'),
      await realTask('src/a/index.ts'),
      await realTask('src/index.ts'),
      await realTask('src/app.ts'),
    ];
    const graph = buildUsageGraph(testDir, tasks);
    expect(getTransitiveImporters(graph, 'Widget', 'src/a/widget.ts')).toEqual([
      'src/a/index.ts',
      'src/app.ts',
      'src/index.ts',
    ]);
  });

  it('equals direct importers when there is no barrel, and excludes the source', async () => {
    createFile('src/util.ts', 'export class Helper {}\n');
    createFile('src/one.ts', "import { Helper } from './util';\nexport const a = () => new Helper();\n");

    const tasks = [await realTask('src/util.ts'), await realTask('src/one.ts')];
    const graph = buildUsageGraph(testDir, tasks);
    expect(getTransitiveImporters(graph, 'Helper', 'src/util.ts')).toEqual(['src/one.ts']);
  });

  it('returns empty for a symbol nobody imports', async () => {
    createFile('src/lonely.ts', 'export class Unused {}\n');
    const tasks = [await realTask('src/lonely.ts')];
    const graph = buildUsageGraph(testDir, tasks);
    expect(getTransitiveImporters(graph, 'Unused', 'src/lonely.ts')).toEqual([]);
  });

  it('terminates on a re-export cycle (cycle-safe)', () => {
    // Pathological: a.ts and b.ts each re-export Foo from the other.
    const graph: UsageGraph = {
      usages: new Map([
        ['Foo::src/a.ts', new Set(['src/b.ts'])],
        ['Foo::src/b.ts', new Set(['src/a.ts', 'src/leaf.ts'])],
      ]),
      typeOnlyUsages: new Map(),
      intraFileRefs: new Map(),
      noImportFiles: new Set(),
    };
    // Should not loop forever; resolves the reachable set minus the source.
    expect(getTransitiveImporters(graph, 'Foo', 'src/a.ts')).toEqual(['src/b.ts', 'src/leaf.ts']);
  });
});

describe('resolveNonExportedSymbolUtility (non-exported transitive liveness)', () => {
  async function realTask(relPath: string): Promise<Task> {
    const r = await parseFile(relPath, readFileSync(join(testDir, relPath), 'utf-8'));
    return {
      version: 1,
      file: relPath,
      hash: 'realhash',
      symbols: r.symbols,
      ...(r.imports.length > 0 ? { imports: r.imports } : {}),
      ...(r.importsEnriched ? { imports_enriched: true } : {}),
      scanned_at: new Date().toISOString(),
    };
  }

  it('marks a private helper called by a used exported function USED (listenerService FP)', async () => {
    createFile(
      'src/listenerService.ts',
      'const isSystemListener = (n: string) => n === "sys";\n' +
        'export const deleteListener = (n: string) => {\n' +
        '  if (isSystemListener(n)) return false;\n' +
        '  return true;\n' +
        '};\n',
    );
    createFile(
      'src/consumer.ts',
      "import { deleteListener } from './listenerService';\nexport const run = () => deleteListener('x');\n",
    );

    const tasks = [await realTask('src/listenerService.ts'), await realTask('src/consumer.ts')];
    const graph = buildUsageGraph(testDir, tasks);
    const sym = tasks[0].symbols.find((s) => s.name === 'isSystemListener')!;
    expect(sym.exported).toBe(false);
    const verdict = resolveNonExportedSymbolUtility(sym, graph, 'src/listenerService.ts');
    expect(verdict?.value).toBe('USED');
  });

  it('returns null when the only referencing exported symbol is itself never imported', async () => {
    createFile(
      'src/orphan.ts',
      'const helper = () => 1;\nexport const publicFn = () => helper();\n',
    );
    // Nobody imports publicFn → it is not cross-file alive → helper stays undecided.
    const tasks = [await realTask('src/orphan.ts')];
    const graph = buildUsageGraph(testDir, tasks);
    const sym = tasks[0].symbols.find((s) => s.name === 'helper')!;
    expect(resolveNonExportedSymbolUtility(sym, graph, 'src/orphan.ts')).toBeNull();
  });

  it('returns null for a non-exported symbol that nothing references', async () => {
    createFile(
      'src/lonely.ts',
      'const unused = () => 1;\nexport const publicFn = () => 2;\n',
    );
    createFile('src/c.ts', "import { publicFn } from './lonely';\nexport const r = () => publicFn();\n");
    const tasks = [await realTask('src/lonely.ts'), await realTask('src/c.ts')];
    const graph = buildUsageGraph(testDir, tasks);
    const sym = tasks[0].symbols.find((s) => s.name === 'unused')!;
    expect(resolveNonExportedSymbolUtility(sym, graph, 'src/lonely.ts')).toBeNull();
  });

  it('returns null when handed an exported symbol (guard — that path is the exported resolver)', async () => {
    createFile('src/x.ts', 'export const a = () => 1;\nexport const b = () => a();\n');
    createFile('src/c.ts', "import { b } from './x';\nexport const r = () => b();\n");
    const tasks = [await realTask('src/x.ts'), await realTask('src/c.ts')];
    const graph = buildUsageGraph(testDir, tasks);
    const sym = tasks[0].symbols.find((s) => s.name === 'a')!;
    expect(sym.exported).toBe(true);
    expect(resolveNonExportedSymbolUtility(sym, graph, 'src/x.ts')).toBeNull();
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

describe('stripTemplateLiterals', () => {
  it('drops static text but keeps ${...} interpolation contents (no false USED, no false DEAD)', () => {
    const out = stripTemplateLiterals('`Loading ${doStuff()} for processPayment now`');
    expect(out).toContain('doStuff'); // interpolation ref preserved
    expect(out).not.toContain('Loading'); // static prose dropped
    expect(out).not.toContain('processPayment'); // static prose dropped
  });

  it('drops an interpolation-free template entirely', () => {
    const out = stripTemplateLiterals('const s = `just static processPayment text`;');
    expect(out).not.toContain('processPayment');
    expect(out).toContain('const s =');
  });

  it('handles nested template literals, keeping every interpolation identifier', () => {
    const out = stripTemplateLiterals('`a ${inner(`x ${deep()} y`)} b`');
    expect(out).toContain('inner');
    expect(out).toContain('deep');
    expect(out).not.toMatch(/\ba\b|\bx\b|\by\b|\bb\b/); // static single-letter words dropped
  });

  it('leaves non-template code untouched', () => {
    const src = 'function foo() { return bar(); }';
    expect(stripTemplateLiterals(src)).toBe(src);
  });
});

describe('getImportedSymbolsBySource', () => {
  function graphWith(usages: Record<string, string[]>): UsageGraph {
    const m = new Map<string, Set<string>>();
    for (const [key, importers] of Object.entries(usages)) m.set(key, new Set(importers));
    return { usages: m, typeOnlyUsages: new Map(), intraFileRefs: new Map(), noImportFiles: new Set() };
  }

  it('inverts the usage graph to the symbols a file imports, grouped by source', () => {
    const g = graphWith({
      'getCarriers::src/audio/device.ts': ['src/ui/analyzer.ts', 'src/engine.ts'],
      'getDivisors::src/audio/device.ts': ['src/ui/analyzer.ts'],
      'unrelated::src/other.ts': ['src/engine.ts'],
    });
    const out = getImportedSymbolsBySource(g, 'src/ui/analyzer.ts');
    expect([...out.keys()]).toEqual(['src/audio/device.ts']);
    expect([...out.get('src/audio/device.ts')!].sort()).toEqual(['getCarriers', 'getDivisors']);
  });

  it('returns an empty map when the file imports nothing', () => {
    const g = graphWith({ 'foo::src/a.ts': ['src/b.ts'] });
    expect(getImportedSymbolsBySource(g, 'src/c.ts').size).toBe(0);
  });

  it('skips self-edges and splits keys on the last "::" (path-safe)', () => {
    const g = graphWith({
      'self::src/x.ts': ['src/x.ts'],          // self-edge, ignored
      'helper::src/lib/util.ts': ['src/x.ts'], // real edge
    });
    const out = getImportedSymbolsBySource(g, 'src/x.ts');
    expect([...out.keys()]).toEqual(['src/lib/util.ts']);
    expect([...out.get('src/lib/util.ts')!]).toEqual(['helper']);
  });
});
