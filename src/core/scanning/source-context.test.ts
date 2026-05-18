// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { buildPageContext, type SourceFile } from './source-context.js';

/**
 * Story 29.7: Source Code Analysis for Documentation
 *
 * Tests validate that buildPageContext() extracts relevant source code
 * context for each scaffolded doc page, including exported symbols,
 * re-exports, import graphs, and applies token-based truncation.
 */

describe('buildPageContext', () => {
  // --- AC1: Module page extracts exported symbols ---
  describe('module page context', () => {
    it('AC: extracts exported symbols with signatures, JSDoc, and body snippet', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/rag/indexer.ts',
          content: [
            '/** Builds function cards from AST. */',
            'export function buildFunctionCards(task: Task, source: string): FunctionCard[] {',
            '  const cards: FunctionCard[] = [];',
            '  for (const sym of task.symbols) {',
            '    cards.push({ name: sym.name });',
            '  }',
            '  return cards;',
            '}',
          ].join('\n'),
          symbols: [
            { name: 'buildFunctionCards', kind: 'function', exported: true, line_start: 2, line_end: 8 },
          ],
        },
      ];

      const ctx = buildPageContext('05-Modules/rag.md', sourceFiles);

      expect(ctx.exports).toHaveLength(1);
      expect(ctx.exports[0].name).toBe('buildFunctionCards');
      expect(ctx.exports[0].kind).toBe('function');
      expect(ctx.exports[0].signature).toContain('buildFunctionCards');
      expect(ctx.exports[0].signature).toContain('Task');
      expect(ctx.exports[0].jsdoc).toContain('Builds function cards from AST');
      expect(ctx.exports[0].bodySnippet).toContain('const cards');
    });

    it('AC: includes file tree of module directory', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/rag/indexer.ts',
          content: 'export function foo() {}',
          symbols: [{ name: 'foo', kind: 'function', exported: true, line_start: 1, line_end: 1 }],
        },
        {
          path: 'src/rag/types.ts',
          content: 'export type Bar = string;',
          symbols: [{ name: 'Bar', kind: 'type', exported: true, line_start: 1, line_end: 1 }],
        },
      ];

      const ctx = buildPageContext('05-Modules/rag.md', sourceFiles);

      expect(ctx.fileTree).toContain('indexer.ts');
      expect(ctx.fileTree).toContain('types.ts');
    });

    it('body snippet is limited to first 20 lines', () => {
      const bodyLines = Array.from({ length: 30 }, (_, i) => `  const line${i} = ${i};`);
      const content = [
        'export function bigFunction(): void {',
        ...bodyLines,
        '}',
      ].join('\n');

      const sourceFiles: SourceFile[] = [
        {
          path: 'src/mod/big.ts',
          content,
          symbols: [{ name: 'bigFunction', kind: 'function', exported: true, line_start: 1, line_end: 32 }],
        },
      ];

      const ctx = buildPageContext('05-Modules/mod.md', sourceFiles);

      const snippetLines = ctx.exports[0].bodySnippet.split('\n');
      expect(snippetLines.length).toBeLessThanOrEqual(20);
    });

    it('separates exported and internal symbols', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/mod/mixed.ts',
          content: 'export function pub() {}\nfunction priv() {}',
          symbols: [
            { name: 'pub', kind: 'function', exported: true, line_start: 1, line_end: 1 },
            { name: 'priv', kind: 'function', exported: false, line_start: 2, line_end: 2 },
          ],
        },
      ];

      const ctx = buildPageContext('05-Modules/mod.md', sourceFiles);

      expect(ctx.exports).toHaveLength(1);
      expect(ctx.exports[0].name).toBe('pub');
      expect(ctx.internals).toHaveLength(1);
      expect(ctx.internals[0].name).toBe('priv');
    });
  });

  // --- AC2: Public API page extracts re-exports ---
  describe('public API page context', () => {
    it('AC: extracts named re-exports with source modules', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/index.ts',
          content: [
            "export { buildFunctionCards } from './rag/indexer.js';",
            "export { type Config } from './schemas/config.js';",
          ].join('\n'),
          symbols: [],
        },
      ];

      const ctx = buildPageContext('04-API-Reference/01-Public-API.md', sourceFiles);

      expect(ctx.reExports).toHaveLength(2);
      expect(ctx.reExports[0].name).toBe('buildFunctionCards');
      expect(ctx.reExports[0].sourceModule).toBe('./rag/indexer.js');
      expect(ctx.reExports[1].name).toBe('Config');
      expect(ctx.reExports[1].sourceModule).toBe('./schemas/config.js');
    });

    it('AC: extracts star re-exports', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/index.ts',
          content: "export * from './core/scanner.js';",
          symbols: [],
        },
      ];

      const ctx = buildPageContext('04-API-Reference/01-Public-API.md', sourceFiles);

      expect(ctx.reExports).toHaveLength(1);
      expect(ctx.reExports[0].name).toBe('*');
      expect(ctx.reExports[0].sourceModule).toBe('./core/scanner.js');
    });
  });

  // --- AC3: Architecture page extracts source tree and import graph ---
  describe('architecture page context', () => {
    it('AC: extracts top-level source tree showing directories', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/core/scanner.ts',
          content: 'export function scan() {}',
          symbols: [{ name: 'scan', kind: 'function', exported: true, line_start: 1, line_end: 1 }],
        },
        {
          path: 'src/rag/indexer.ts',
          content: 'export function index() {}',
          symbols: [{ name: 'index', kind: 'function', exported: true, line_start: 1, line_end: 1 }],
        },
      ];

      const ctx = buildPageContext('02-Architecture/01-System-Overview.md', sourceFiles);

      expect(ctx.fileTree).toContain('core');
      expect(ctx.fileTree).toContain('rag');
    });

    it('AC: extracts import graph between files', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/core/evaluator.ts',
          content: "import { buildCards } from '../rag/indexer.js';\nexport function evaluate() { buildCards(); }",
          symbols: [{ name: 'evaluate', kind: 'function', exported: true, line_start: 2, line_end: 2 }],
        },
        {
          path: 'src/rag/indexer.ts',
          content: 'export function buildCards() {}',
          symbols: [{ name: 'buildCards', kind: 'function', exported: true, line_start: 1, line_end: 1 }],
        },
      ];

      const ctx = buildPageContext('02-Architecture/01-System-Overview.md', sourceFiles);

      expect(ctx.importGraph.length).toBeGreaterThan(0);
      const edge = ctx.importGraph.find(e => e.from.includes('evaluator'));
      expect(edge).toBeTruthy();
      expect(edge!.to).toContain('indexer');
    });

    it('does not extract import graph for non-architecture pages', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/core/evaluator.ts',
          content: "import { foo } from './foo.js';\nexport function bar() {}",
          symbols: [{ name: 'bar', kind: 'function', exported: true, line_start: 2, line_end: 2 }],
        },
      ];

      const ctx = buildPageContext('05-Modules/evaluator.md', sourceFiles);

      expect(ctx.importGraph).toEqual([]);
    });
  });

  // --- AC4: Token truncation ---
  describe('token truncation', () => {
    it('AC: sets truncated flag when context exceeds maxTokens', () => {
      const bigBody = Array.from({ length: 100 }, (_, i) => `  const v${i} = ${i};`).join('\n');
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/mod/big.ts',
          content: `export function big(): void {\n${bigBody}\n}`,
          symbols: [
            { name: 'big', kind: 'function', exported: true, line_start: 1, line_end: 102 },
          ],
        },
      ];

      const ctx = buildPageContext('05-Modules/mod.md', sourceFiles, { maxTokens: 50 });

      expect(ctx.truncated).toBe(true);
      expect(ctx.tokenCount).toBeLessThanOrEqual(50);
    });

    it('does not truncate when within limit', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/mod/small.ts',
          content: 'export function small(): void {}',
          symbols: [
            { name: 'small', kind: 'function', exported: true, line_start: 1, line_end: 1 },
          ],
        },
      ];

      const ctx = buildPageContext('05-Modules/mod.md', sourceFiles, { maxTokens: 8000 });

      expect(ctx.truncated).toBe(false);
    });

    it('removes internal helpers first (lowest priority)', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/mod/mixed.ts',
          content: 'export function pub(): void {}\nfunction internal(): void { /* lots of code */ }',
          symbols: [
            { name: 'pub', kind: 'function', exported: true, line_start: 1, line_end: 1 },
            { name: 'internal', kind: 'function', exported: false, line_start: 2, line_end: 2 },
          ],
        },
      ];

      // Without truncation, both should be present
      const full = buildPageContext('05-Modules/mod.md', sourceFiles, { maxTokens: 8000 });
      expect(full.internals).toHaveLength(1);

      // With truncation, internals should be removed first
      const truncated = buildPageContext('05-Modules/mod.md', sourceFiles, { maxTokens: 30 });
      expect(truncated.truncated).toBe(true);
      expect(truncated.internals).toHaveLength(0);
      expect(truncated.exports).toHaveLength(1);
      expect(truncated.exports[0].name).toBe('pub');
    });

    it('keeps exported signatures even under severe truncation', () => {
      const bigBody = Array.from({ length: 100 }, (_, i) => `  const v${i} = ${i};`).join('\n');
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/mod/huge.ts',
          content: `/** Big doc */\nexport function hugeFn(): void {\n${bigBody}\n}`,
          symbols: [
            { name: 'hugeFn', kind: 'function', exported: true, line_start: 2, line_end: 103 },
          ],
        },
      ];

      const ctx = buildPageContext('05-Modules/mod.md', sourceFiles, { maxTokens: 20 });

      expect(ctx.truncated).toBe(true);
      expect(ctx.exports).toHaveLength(1);
      expect(ctx.exports[0].name).toBe('hugeFn');
      expect(ctx.exports[0].signature).toContain('hugeFn');
    });
  });

  // --- Edge cases ---
  describe('edge cases', () => {
    it('returns empty context for empty source files', () => {
      const ctx = buildPageContext('05-Modules/empty.md', []);

      expect(ctx.exports).toEqual([]);
      expect(ctx.internals).toEqual([]);
      expect(ctx.reExports).toEqual([]);
      expect(ctx.importGraph).toEqual([]);
      expect(ctx.fileTree).toBe('');
      expect(ctx.truncated).toBe(false);
    });

    it('handles multi-line JSDoc comments', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/mod/documented.ts',
          content: [
            '/**',
            ' * Processes input data.',
            ' * @param data The data to process',
            ' */',
            'export function processData(data: string): void {',
            '  console.log(data);',
            '}',
          ].join('\n'),
          symbols: [
            { name: 'processData', kind: 'function', exported: true, line_start: 5, line_end: 7 },
          ],
        },
      ];

      const ctx = buildPageContext('05-Modules/mod.md', sourceFiles);

      expect(ctx.exports[0].jsdoc).toContain('Processes input data');
      expect(ctx.exports[0].jsdoc).toContain('@param data');
    });

    it('returns null jsdoc when no JSDoc present', () => {
      const sourceFiles: SourceFile[] = [
        {
          path: 'src/mod/no-doc.ts',
          content: 'export function noDoc(): void {}',
          symbols: [
            { name: 'noDoc', kind: 'function', exported: true, line_start: 1, line_end: 1 },
          ],
        },
      ];

      const ctx = buildPageContext('05-Modules/mod.md', sourceFiles);

      expect(ctx.exports[0].jsdoc).toBeNull();
    });
  });
});
