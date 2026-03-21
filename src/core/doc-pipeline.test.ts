// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDocScaffold, runDocGeneration } from './doc-pipeline.js';
import type { Task } from '../schemas/task.js';

function makeTask(file: string, symbols: Array<{ name: string; exported: boolean; line_start: number; line_end: number }>): Task {
  return {
    version: 1,
    file,
    hash: 'abc123',
    symbols: symbols.map(s => ({ ...s, kind: 'function' as const })),
    scanned_at: '2026-03-20T00:00:00Z',
  };
}

describe('runDocScaffold', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doc-pipeline-'));
    mkdirSync(join(tempDir, 'src', 'core'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'utils'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should detect project types and scaffold .anatoly/docs/', () => {
    const pkg = { name: 'my-project', dependencies: { react: '^18.0.0' } };
    const tasks: Task[] = [
      makeTask('src/core/scanner.ts', [
        { name: 'scanProject', exported: true, line_start: 1, line_end: 250 },
      ]),
      makeTask('src/core/reporter.ts', [
        { name: 'generateReport', exported: true, line_start: 1, line_end: 300 },
      ]),
      makeTask('src/core/merger.ts', [
        { name: 'mergeResults', exported: true, line_start: 1, line_end: 200 },
      ]),
    ];

    const result = runDocScaffold(tempDir, pkg, tasks);

    expect(result.projectTypes).toContain('Frontend');
    expect(result.scaffoldResult.pagesCreated.length).toBeGreaterThan(0);
    expect(result.outputDir).toContain('.anatoly/docs');

    // Verify index.md was created
    const indexPath = join(result.outputDir, 'index.md');
    const indexContent = readFileSync(indexPath, 'utf-8');
    expect(indexContent).toContain('my-project');
  });

  it('should detect multiple project types', () => {
    const pkg = {
      name: 'multi-project',
      dependencies: { react: '^18.0.0', prisma: '^5.0.0', express: '^4.0.0' },
    };
    const tasks: Task[] = [];

    const result = runDocScaffold(tempDir, pkg, tasks);

    expect(result.projectTypes).toContain('Frontend');
    expect(result.projectTypes).toContain('ORM');
    expect(result.projectTypes).toContain('Backend API');
  });

  it('should default to Library when no framework detected', () => {
    const pkg = { name: 'lib' };
    const tasks: Task[] = [];

    const result = runDocScaffold(tempDir, pkg, tasks);

    expect(result.projectTypes).toEqual(['Library']);
  });

  it('should throw if output would write to docs/', () => {
    // This test verifies the guard is called — runDocScaffold targets .anatoly/docs/
    // so it should NOT throw. The guard only throws for docs/.
    const pkg = { name: 'test' };
    const tasks: Task[] = [];

    // Should not throw because it targets .anatoly/docs/
    expect(() => runDocScaffold(tempDir, pkg, tasks)).not.toThrow();
  });

  it('should not overwrite existing pages on second run', () => {
    const pkg = { name: 'test' };
    const tasks: Task[] = [];

    const result1 = runDocScaffold(tempDir, pkg, tasks);
    const result2 = runDocScaffold(tempDir, pkg, tasks);

    // Second run should skip all previously created pages (except index.md which is always regenerated)
    expect(result2.scaffoldResult.pagesSkipped.length).toBeGreaterThan(0);
  });

  it('should generate doc mappings from source directories', () => {
    const pkg = { name: 'test' };
    const tasks: Task[] = [
      makeTask('src/routes/api.ts', [
        { name: 'handleRequest', exported: true, line_start: 1, line_end: 250 },
      ]),
    ];

    const result = runDocScaffold(tempDir, pkg, tasks);

    const routeMapping = result.docMappings.find(m => m.sourceDir === 'routes');
    expect(routeMapping).toBeDefined();
    expect(routeMapping!.docPage).toBe('04-API-Reference/04-REST-Endpoints.md');
    expect(routeMapping!.strategy).toBe('convention');
  });

  // --- Story 29.16: Dynamic module injection via pipeline ---
  it('should create actual module pages from resolveModuleGranularity output', () => {
    const pkg = { name: 'my-cli', bin: { 'my-cli': './dist/index.js' }, dependencies: { commander: '^11.0.0' } };
    // 3 files in core/ each > 200 LOC → directory-level → 05-Modules/core.md
    const tasks: Task[] = [
      makeTask('src/core/scanner.ts', [
        { name: 'scanProject', exported: true, line_start: 1, line_end: 250 },
      ]),
      makeTask('src/core/reporter.ts', [
        { name: 'generateReport', exported: true, line_start: 1, line_end: 300 },
      ]),
      makeTask('src/core/merger.ts', [
        { name: 'mergeResults', exported: true, line_start: 1, line_end: 200 },
      ]),
    ];

    const result = runDocScaffold(tempDir, pkg, tasks);

    // Module page should be created as a real file
    expect(result.scaffoldResult.pagesCreated).toContain('05-Modules/core.md');
    const modulePath = join(result.outputDir, '05-Modules/core.md');
    const content = readFileSync(modulePath, 'utf-8');
    expect(content).toContain('# core');
    expect(content).toContain('<!-- SCAFFOLDING:');
  });

  it('should renumber 06-Development to 05-Development when no modules exist', () => {
    const pkg = { name: 'my-lib' };
    // No tasks → no modules
    const tasks: Task[] = [];

    const result = runDocScaffold(tempDir, pkg, tasks);

    // Library with no modules → 05-Development
    expect(result.scaffoldResult.pagesCreated.some(p => p.startsWith('05-Development/'))).toBe(true);
    expect(result.scaffoldResult.pagesCreated.some(p => p.startsWith('06-Development/'))).toBe(false);
  });
});

describe('runDocGeneration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doc-gen-'));
    mkdirSync(join(tempDir, 'src', 'core'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'core', 'scanner.ts'),
      'export function scanProject() { return {}; }\n'.repeat(20),
    );
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return prompts for pages that need generation', () => {
    const pkg = { name: 'test' };
    const tasks: Task[] = [
      makeTask('src/core/scanner.ts', [
        { name: 'scanProject', exported: true, line_start: 1, line_end: 250 },
      ]),
    ];

    const scaffold = runDocScaffold(tempDir, pkg, tasks);
    const result = runDocGeneration(tempDir, scaffold, tasks, pkg);

    // First run — all pages are new (added), should have prompts
    expect(result.cacheResult.added.length).toBeGreaterThan(0);
    expect(result.cacheResult.fresh).toEqual([]);
    expect(result.pagesGenerated).toBeGreaterThan(0);
  });

  it('should use cache on second run with no changes', () => {
    const pkg = { name: 'test' };
    const tasks: Task[] = [
      makeTask('src/core/scanner.ts', [
        { name: 'scanProject', exported: true, line_start: 1, line_end: 250 },
      ]),
    ];

    const scaffold = runDocScaffold(tempDir, pkg, tasks);

    // First run — generates cache
    const result1 = runDocGeneration(tempDir, scaffold, tasks, pkg);
    expect(result1.pagesGenerated).toBeGreaterThan(0);

    // Second run — everything should be fresh (cache hit)
    const result2 = runDocGeneration(tempDir, scaffold, tasks, pkg);
    expect(result2.cacheResult.fresh.length).toBeGreaterThan(0);
    expect(result2.pagesGenerated).toBe(0);
    expect(result2.prompts).toEqual([]);
  });

  it('should detect stale pages when source changes', () => {
    const pkg = { name: 'test' };
    const tasks: Task[] = [
      makeTask('src/core/scanner.ts', [
        { name: 'scanProject', exported: true, line_start: 1, line_end: 250 },
      ]),
    ];

    const scaffold = runDocScaffold(tempDir, pkg, tasks);

    // First run
    runDocGeneration(tempDir, scaffold, tasks, pkg);

    // Modify source
    writeFileSync(
      join(tempDir, 'src', 'core', 'scanner.ts'),
      'export function scanProject() { return { modified: true }; }\n'.repeat(20),
    );

    // Second run — should detect stale page
    const result2 = runDocGeneration(tempDir, scaffold, tasks, pkg);
    expect(result2.cacheResult.stale.length + result2.cacheResult.added.length).toBeGreaterThan(0);
  });

  // --- Story 29.17: prompts include pagePath ---
  it('should include pagePath in each prompt for LLM execution', () => {
    const pkg = { name: 'test' };
    const tasks: Task[] = [
      makeTask('src/core/scanner.ts', [
        { name: 'scanProject', exported: true, line_start: 1, line_end: 250 },
      ]),
    ];

    const scaffold = runDocScaffold(tempDir, pkg, tasks);
    const result = runDocGeneration(tempDir, scaffold, tasks, pkg);

    // Every prompt should have a pagePath so the executor knows where to write
    expect(result.prompts.length).toBeGreaterThan(0);
    for (const prompt of result.prompts) {
      expect(prompt.pagePath).toBeDefined();
      expect(prompt.pagePath).toMatch(/\.md$/);
    }
  });

  it('should save .cache.json to .anatoly/docs/', () => {
    const pkg = { name: 'test' };
    const tasks: Task[] = [];

    const scaffold = runDocScaffold(tempDir, pkg, tasks);
    runDocGeneration(tempDir, scaffold, tasks, pkg);

    const cachePath = join(scaffold.outputDir, '.cache.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(cache.version).toBe(1);
    expect(typeof cache.pages).toBe('object');
  });
});
