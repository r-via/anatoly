// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocsTree, resolveRelevantDocs, resolveAllRelevantDocs } from './docs-resolver.js';
import type { Config } from '../schemas/config.js';
import { ConfigSchema } from '../schemas/config.js';

const TMP = join(import.meta.dirname ?? '.', '__test_docs_resolver__');

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeDoc(relPath: string, content: string): void {
  const fullPath = join(TMP, 'docs', relPath);
  ensureDir(join(fullPath, '..'));
  writeFileSync(fullPath, content, 'utf-8');
}

function makeConfig(overrides: Partial<{ docs_path: string; module_mapping: Record<string, string[]> }> = {}): Config {
  return ConfigSchema.parse({
    documentation: {
      docs_path: 'docs',
      ...overrides,
    },
  });
}

beforeEach(() => {
  ensureDir(TMP);
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('buildDocsTree', () => {
  it('returns null when docs dir does not exist', () => {
    expect(buildDocsTree(TMP, 'docs')).toBeNull();
  });

  it('returns null when docs dir is empty', () => {
    ensureDir(join(TMP, 'docs'));
    expect(buildDocsTree(TMP, 'docs')).toBeNull();
  });

  it('returns ASCII tree of .md files', () => {
    writeDoc('01-Getting-Started/quickstart.md', '# Quickstart');
    writeDoc('02-Architecture/overview.md', '# Overview');
    writeDoc('02-Architecture/axes.md', '# Axes');

    const tree = buildDocsTree(TMP, 'docs');
    expect(tree).not.toBeNull();
    expect(tree).toContain('01-Getting-Started');
    expect(tree).toContain('quickstart.md');
    expect(tree).toContain('02-Architecture');
    expect(tree).toContain('overview.md');
    expect(tree).toContain('axes.md');
  });

  it('ignores non-.md files', () => {
    writeDoc('readme.md', '# Readme');
    writeFileSync(join(TMP, 'docs', 'image.png'), 'binary');

    const tree = buildDocsTree(TMP, 'docs');
    expect(tree).toContain('readme.md');
    expect(tree).not.toContain('image.png');
  });
});

describe('resolveRelevantDocs', () => {
  it('returns empty when docsTree is null', () => {
    const config = makeConfig();
    expect(resolveRelevantDocs('src/core/scanner.ts', null, config, TMP)).toEqual([]);
  });

  it('resolves via config mapping (primary)', () => {
    writeDoc('04-Core-Modules/scanner.md', '# Scanner\nLine 2\n');

    const config = makeConfig({
      module_mapping: {
        'src/core': ['04-Core-Modules'],
      },
    });

    const tree = buildDocsTree(TMP, 'docs')!;
    const docs = resolveRelevantDocs('src/core/scanner.ts', tree, config, TMP);

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0].path).toContain('scanner.md');
    expect(docs[0].content).toContain('# Scanner');
  });

  it('falls back to convention matching', () => {
    writeDoc('04-Core-Modules/index.md', '# Core Modules');

    const config = makeConfig();
    const tree = buildDocsTree(TMP, 'docs')!;
    const docs = resolveRelevantDocs('src/core/scanner.ts', tree, config, TMP);

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0].path).toContain('04-Core-Modules');
  });

  it('returns empty when no match found', () => {
    writeDoc('01-Getting-Started/quickstart.md', '# Quickstart');

    const config = makeConfig();
    const tree = buildDocsTree(TMP, 'docs')!;
    const docs = resolveRelevantDocs('src/rag/vector-store.ts', tree, config, TMP);

    // "rag" doesn't match "getting started"
    expect(docs).toEqual([]);
  });

  it('truncates pages at 300 lines', () => {
    const longContent = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}`).join('\n');
    writeDoc('02-Architecture/big.md', longContent);

    const config = makeConfig({
      module_mapping: { 'src/core': ['02-Architecture'] },
    });

    const tree = buildDocsTree(TMP, 'docs')!;
    const docs = resolveRelevantDocs('src/core/foo.ts', tree, config, TMP);

    expect(docs.length).toBe(1);
    expect(docs[0].content).toContain('truncated at 300 lines');
    expect(docs[0].content.split('\n').length).toBeLessThan(310);
  });

  it('caps at 3 pages', () => {
    for (let i = 1; i <= 5; i++) {
      writeDoc(`04-Core-Modules/page${i}.md`, `# Page ${i}`);
    }

    const config = makeConfig({
      module_mapping: { 'src/core': ['04-Core-Modules'] },
    });

    const tree = buildDocsTree(TMP, 'docs')!;
    const docs = resolveRelevantDocs('src/core/foo.ts', tree, config, TMP);

    expect(docs.length).toBe(3);
  });

  // --- Story 29.18: source tagging ---
  it('tags docs with source when provided', () => {
    writeDoc('04-Core-Modules/scanner.md', '# Scanner');

    const config = makeConfig({
      module_mapping: { 'src/core': ['04-Core-Modules'] },
    });

    const tree = buildDocsTree(TMP, 'docs')!;
    const docs = resolveRelevantDocs('src/core/scanner.ts', tree, config, TMP, {
      source: 'project',
    });

    expect(docs.length).toBe(1);
    expect(docs[0].source).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// Story 29.18: Dual doc context — resolveAllRelevantDocs
// ---------------------------------------------------------------------------

function writeInternalDoc(relPath: string, content: string): void {
  const fullPath = join(TMP, '.anatoly', 'docs', relPath);
  ensureDir(join(fullPath, '..'));
  writeFileSync(fullPath, content, 'utf-8');
}

describe('resolveAllRelevantDocs (Story 29.18)', () => {
  // AC1: both project and internal docs included, tagged with source
  it('merges project and internal docs with source tags', () => {
    writeDoc('04-Core-Modules/scanner.md', '# Scanner (project)');
    writeInternalDoc('04-Core-Modules/core.md', '# Core (internal)');

    const config = makeConfig({
      module_mapping: { 'src/core': ['04-Core-Modules'] },
    });
    const docsTree = buildDocsTree(TMP, 'docs')!;
    const internalDocsTree = buildDocsTree(TMP, join('.anatoly', 'docs'))!;
    const internalDocsDir = join(TMP, '.anatoly', 'docs');

    const docs = resolveAllRelevantDocs('src/core/scanner.ts', config, TMP, {
      docsTree,
      internalDocsTree,
      internalDocsDir,
    });

    // Both sources included
    expect(docs.length).toBe(2);
    const projectDocs = docs.filter(d => d.source === 'project');
    const internalDocs = docs.filter(d => d.source === 'internal');
    expect(projectDocs.length).toBe(1);
    expect(internalDocs.length).toBe(1);
    expect(projectDocs[0].content).toContain('Scanner (project)');
    expect(internalDocs[0].content).toContain('Core (internal)');
  });

  // AC2: no docs/ but .anatoly/docs/ filled → internal docs tagged
  it('returns internal docs when no project docs exist', () => {
    // Convention matching: "04-Core" normalizes to "core", matches "core" segment from src/core/
    writeInternalDoc('04-Core/overview.md', '# Core Module');

    const config = makeConfig();
    const internalDocsTree = buildDocsTree(TMP, join('.anatoly', 'docs'))!;
    const internalDocsDir = join(TMP, '.anatoly', 'docs');

    const docs = resolveAllRelevantDocs('src/core/scanner.ts', config, TMP, {
      docsTree: null,
      internalDocsTree,
      internalDocsDir,
    });

    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every(d => d.source === 'internal')).toBe(true);
  });

  // AC3: both sources for same module → no deduplication
  it('includes both sources without deduplication', () => {
    writeDoc('05-Modules/core.md', '# Core (project version)');
    writeInternalDoc('05-Modules/core.md', '# Core (internal version)');

    const config = makeConfig({
      module_mapping: { 'src/core': ['05-Modules'] },
    });
    const docsTree = buildDocsTree(TMP, 'docs')!;
    const internalDocsTree = buildDocsTree(TMP, join('.anatoly', 'docs'))!;
    const internalDocsDir = join(TMP, '.anatoly', 'docs');

    const docs = resolveAllRelevantDocs('src/core/scanner.ts', config, TMP, {
      docsTree,
      internalDocsTree,
      internalDocsDir,
    });

    // Both versions included (same module name, different sources)
    const projectDocs = docs.filter(d => d.source === 'project');
    const internalDocs = docs.filter(d => d.source === 'internal');
    expect(projectDocs.length).toBeGreaterThan(0);
    expect(internalDocs.length).toBeGreaterThan(0);
  });

  it('returns empty when neither source has relevant docs', () => {
    const config = makeConfig();

    const docs = resolveAllRelevantDocs('src/rag/vector-store.ts', config, TMP, {
      docsTree: null,
      internalDocsTree: null,
      internalDocsDir: join(TMP, '.anatoly', 'docs'),
    });

    expect(docs).toEqual([]);
  });
});
