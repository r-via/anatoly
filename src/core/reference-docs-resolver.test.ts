// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema, type Config } from '../schemas/config.js';
import { resolveReferenceDocs, classifySource, type ReferenceDoc } from './reference-docs-resolver.js';

const TMP = join(import.meta.dirname ?? '.', '__test_reference_docs_resolver__');

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeFile(relPath: string, content: string): void {
  const fullPath = join(TMP, relPath);
  ensureDir(join(fullPath, '..'));
  writeFileSync(fullPath, content, 'utf-8');
}

function makeConfig(overrides: {
  paths?: string[];
  inline_comments?: { enabled: boolean; kinds?: string[]; include?: string[] };
  internal_mode?: string;
} = {}): Config {
  return ConfigSchema.parse({
    documentation: {
      reference: {
        paths: overrides.paths ?? ['docs/**/*.md', 'README.md'],
        inline_comments: overrides.inline_comments ?? { enabled: false },
      },
      internal: { mode: overrides.internal_mode ?? 'off' },
    },
  });
}

beforeEach(() => {
  ensureDir(TMP);
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// --- classifySource ---
describe('classifySource', () => {
  it('classifies README.md as readme', () => {
    expect(classifySource('README.md')).toBe('readme');
  });

  it('classifies nested readme as readme', () => {
    expect(classifySource('subdir/README.md')).toBe('readme');
  });

  it('classifies files under specs/ as spec', () => {
    expect(classifySource('specs/api.md')).toBe('spec');
  });

  it('classifies other .md files as md', () => {
    expect(classifySource('docs/guide.md')).toBe('md');
  });

  it('classifies ARCHITECTURE.md as md', () => {
    expect(classifySource('ARCHITECTURE.md')).toBe('md');
  });
});

// --- resolveReferenceDocs: markdown resolution ---
describe('resolveReferenceDocs — markdown files', () => {
  it('AC 54.4a: resolves markdown files matching glob patterns', async () => {
    writeFile('docs/guide.md', '# Guide\nSome content');
    writeFile('docs/api.md', '# API\nAPI docs');
    writeFile('README.md', '# Project README');

    const config = makeConfig({ paths: ['docs/**/*.md', 'README.md'] });
    const result = await resolveReferenceDocs(TMP, config);

    const mdDocs = result.filter((r) => r.source === 'md');
    const readmes = result.filter((r) => r.source === 'readme');
    expect(mdDocs.length).toBe(2);
    expect(readmes.length).toBe(1);
    expect(readmes[0]!.content).toContain('Project README');
  });

  it('AC 54.4a: source field is correctly set for each type', async () => {
    writeFile('docs/intro.md', '# Intro');
    writeFile('README.md', '# README');
    writeFile('specs/spec1.md', '# Spec');

    const config = makeConfig({ paths: ['docs/**/*.md', 'README.md', 'specs/**/*.md'] });
    const result = await resolveReferenceDocs(TMP, config);

    expect(result.find((r) => r.path === 'docs/intro.md')!.source).toBe('md');
    expect(result.find((r) => r.path === 'README.md')!.source).toBe('readme');
    expect(result.find((r) => r.path === 'specs/spec1.md')!.source).toBe('spec');
  });

  it('AC 54.4c: graceful handling of unmatched patterns', async () => {
    writeFile('README.md', '# README');

    const config = makeConfig({ paths: ['README.md', 'specs/**/*.md'] });
    const result = await resolveReferenceDocs(TMP, config);

    // specs/**/*.md matches nothing but doesn't crash
    expect(result.length).toBe(1);
    expect(result[0]!.source).toBe('readme');
  });

  it('returns empty array when no config documentation', async () => {
    const config = ConfigSchema.parse({});
    const result = await resolveReferenceDocs(TMP, config);
    expect(result).toEqual([]);
  });
});

// --- resolveReferenceDocs: inline comments ---
describe('resolveReferenceDocs — inline comments', () => {
  it('AC 54.4b: no comment extraction when inline_comments.enabled is false', async () => {
    writeFile('src/foo.ts', '/** JSDoc */ export function foo() {}');

    const config = makeConfig({
      paths: ['README.md'],
      inline_comments: { enabled: false },
    });
    writeFile('README.md', '# README');
    const result = await resolveReferenceDocs(TMP, config);

    expect(result.filter((r) => r.source === 'comment')).toHaveLength(0);
  });

  it('AC 54.4a: extracts doc-comments when inline_comments enabled', async () => {
    // This test uses real tree-sitter parsing with TypeScript adapter
    // It may need the grammar available, so we mock parseToRootNode
    const mockModule = await import('./scanner.js');
    const mockNode = await import('./language-adapters.js');

    // Create a TypeScript file with a JSDoc comment before an exported function
    writeFile('src/example.ts', [
      '/**',
      ' * Example function docs.',
      ' */',
      'export function example() {}',
    ].join('\n'));
    writeFile('README.md', '# README');

    const config = makeConfig({
      paths: ['README.md'],
      inline_comments: {
        enabled: true,
        kinds: ['jsdoc'],
        include: ['src/**/*.ts'],
      },
    });

    // Mock parseToRootNode to return a mock AST that extractDocComments can use
    const tsAdapter = new mockNode.TypeScriptAdapter();
    vi.spyOn(mockModule, 'parseToRootNode').mockImplementation(async (_source, adapter) => {
      if (adapter.languageId === 'typescript') {
        // Build a mock node that produces the right symbol from extractSymbols
        return {
          type: 'program',
          text: '',
          namedChildren: [{
            type: 'export_statement',
            text: 'export function example',
            startPosition: { row: 3, column: 0 },
            endPosition: { row: 3, column: 0 },
            namedChildren: [{
              type: 'function_declaration',
              text: 'function example',
              startPosition: { row: 3, column: 0 },
              endPosition: { row: 3, column: 0 },
              namedChildren: [],
              childForFieldName: (name: string) =>
                name === 'name' ? { type: 'identifier', text: 'example', namedChildren: [], startPosition: { row: 3, column: 0 }, endPosition: { row: 3, column: 0 }, childForFieldName: () => null } as any : null,
            }],
            childForFieldName: () => null,
          }],
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 3, column: 0 },
          childForFieldName: () => null,
        } as any;
      }
      return null;
    });

    const result = await resolveReferenceDocs(TMP, config);
    const comments = result.filter((r) => r.source === 'comment');
    expect(comments.length).toBe(1);
    expect(comments[0]!.symbol).toBe('example');
    expect(comments[0]!.lang).toBe('typescript');
    expect(comments[0]!.content).toContain('Example function docs.');
  });

  it('AC 54.4a: comment entries have symbol and lang filled', async () => {
    const mockModule = await import('./scanner.js');

    writeFile('src/app.py', [
      'def public_func():',
      '    """Public docstring."""',
      '    pass',
    ].join('\n'));
    writeFile('README.md', '# README');

    const config = makeConfig({
      paths: ['README.md'],
      inline_comments: {
        enabled: true,
        kinds: ['docstring'],
        include: ['src/**/*.py'],
      },
    });

    vi.spyOn(mockModule, 'parseToRootNode').mockImplementation(async (_source, adapter) => {
      if (adapter.languageId === 'python') {
        return {
          type: 'module',
          text: '',
          namedChildren: [{
            type: 'function_definition',
            text: 'def public_func',
            startPosition: { row: 0, column: 0 },
            endPosition: { row: 2, column: 0 },
            namedChildren: [],
            childForFieldName: (name: string) =>
              name === 'name' ? { type: 'identifier', text: 'public_func', namedChildren: [], startPosition: { row: 0, column: 0 }, endPosition: { row: 0, column: 0 }, childForFieldName: () => null } as any : null,
          }],
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 2, column: 0 },
          childForFieldName: () => null,
        } as any;
      }
      return null;
    });

    const result = await resolveReferenceDocs(TMP, config);
    const comments = result.filter((r) => r.source === 'comment');
    expect(comments.length).toBe(1);
    expect(comments[0]!.symbol).toBe('public_func');
    expect(comments[0]!.lang).toBe('python');
  });

  it('NFR6: logs warning when grammar not available', async () => {
    const mockModule = await import('./scanner.js');
    const loggerModule = await import('../utils/logger.js');
    const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    vi.spyOn(loggerModule, 'getLogger').mockReturnValue(mockLogger as any);

    writeFile('src/app.ts', '/** doc */ export function foo() {}');
    writeFile('README.md', '# README');

    const config = makeConfig({
      paths: ['README.md'],
      inline_comments: {
        enabled: true,
        kinds: ['jsdoc'],
        include: ['src/**/*.ts'],
      },
    });

    // Simulate grammar not available
    vi.spyOn(mockModule, 'parseToRootNode').mockResolvedValue(null);

    const result = await resolveReferenceDocs(TMP, config);
    expect(result.filter((r) => r.source === 'comment')).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('skipping doc-comment extraction for typescript'),
    );
  });
});

// --- resolveReferenceDocs: logging ---
describe('resolveReferenceDocs — logging', () => {
  it('AC 54.4c: logs summary with counts', async () => {
    const loggerModule = await import('../utils/logger.js');
    const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    vi.spyOn(loggerModule, 'getLogger').mockReturnValue(mockLogger as any);

    writeFile('docs/guide.md', '# Guide');
    writeFile('README.md', '# README');

    const config = makeConfig({ paths: ['docs/**/*.md', 'README.md'] });
    await resolveReferenceDocs(TMP, config);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('resolved 2 reference docs'),
    );
  });
});
