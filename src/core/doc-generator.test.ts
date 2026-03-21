// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { buildPagePrompt, DEFAULT_MODEL } from './doc-generator.js';
import type { PageContext } from './source-context.js';

/**
 * Story 29.8: LLM Page Content Generation
 *
 * Tests validate that buildPagePrompt() constructs the correct system
 * and user prompts for each page type, including template requirements,
 * page-type-specific instructions, and model selection.
 */

const emptyContext: PageContext = {
  fileTree: '',
  exports: [],
  internals: [],
  reExports: [],
  importGraph: [],
  tokenCount: 0,
  truncated: false,
};

const samplePkg = { name: 'my-project', description: 'A cool project', version: '1.0.0' };

describe('buildPagePrompt', () => {
  // --- AC1: Page follows ideal template with real names ---
  describe('page template requirements (AC1)', () => {
    it('system prompt enforces ideal page template structure', () => {
      const result = buildPagePrompt(
        { path: '05-Modules/rag.md', title: 'RAG Module', description: 'RAG engine' },
        emptyContext,
        samplePkg,
      );

      // Template structure requirements
      expect(result.system).toContain('# {Page Title}');
      expect(result.system).toContain('See Also');
      expect(result.system).toMatch(/[Ee]xample/);
      expect(result.system).toContain('blockquote');
    });

    it('user prompt includes source context with real function names and file tree', () => {
      const ctx: PageContext = {
        ...emptyContext,
        exports: [
          {
            name: 'buildCards',
            kind: 'function',
            signature: 'export function buildCards(task: Task): Card[]',
            jsdoc: null,
            bodySnippet: '  return [];',
            filePath: 'src/rag/indexer.ts',
          },
        ],
        fileTree: 'src/rag/indexer.ts\nsrc/rag/types.ts',
      };

      const result = buildPagePrompt(
        { path: '05-Modules/rag.md', title: 'RAG Module', description: 'RAG engine docs' },
        ctx,
        samplePkg,
      );

      expect(result.user).toContain('buildCards');
      expect(result.user).toContain('src/rag/indexer.ts');
      expect(result.user).toContain('src/rag/types.ts');
      expect(result.user).toContain('RAG Module');
      expect(result.user).toContain('RAG engine docs');
    });
  });

  // --- AC2: Installation page includes real package info ---
  describe('installation page (AC2)', () => {
    it('includes package name and CLI entry point from package.json', () => {
      const result = buildPagePrompt(
        { path: '01-Getting-Started/02-Installation.md', title: 'Installation', description: 'How to install' },
        emptyContext,
        { name: '@scope/my-tool', bin: { 'my-tool': './dist/cli.js' } },
      );

      expect(result.user).toContain('@scope/my-tool');
      expect(result.user).toContain('my-tool');
    });
  });

  // --- AC3 & AC4: Architecture pages include Mermaid diagrams ---
  describe('architecture pages (AC3, AC4)', () => {
    it('requires Mermaid diagram and includes import graph in context', () => {
      const ctx: PageContext = {
        ...emptyContext,
        importGraph: [
          {
            from: 'src/core/evaluator.ts',
            to: '../rag/indexer.js',
            symbols: ['buildCards'],
          },
        ],
      };

      const result = buildPagePrompt(
        { path: '02-Architecture/01-System-Overview.md', title: 'System Overview', description: 'Overview' },
        ctx,
        samplePkg,
      );

      expect(result.system).toMatch(/[Mm]ermaid/);
      expect(result.user).toContain('evaluator');
      expect(result.user).toContain('indexer');
    });
  });

  // --- AC5: API reference pages include usage examples ---
  describe('API reference pages (AC5)', () => {
    it('requires complete usage examples with expected output', () => {
      const result = buildPagePrompt(
        { path: '04-API-Reference/01-Public-API.md', title: 'Public API', description: 'API ref' },
        emptyContext,
        samplePkg,
      );

      expect(result.system).toMatch(/example/i);
      expect(result.system).toMatch(/expected output|expected response/i);
    });

    it('includes re-exports in context', () => {
      const ctx: PageContext = {
        ...emptyContext,
        reExports: [
          { name: 'buildCards', sourceModule: './rag/indexer.js' },
          { name: '*', sourceModule: './core/scanner.js' },
        ],
      };

      const result = buildPagePrompt(
        { path: '04-API-Reference/01-Public-API.md', title: 'Public API', description: 'API ref' },
        ctx,
        samplePkg,
      );

      expect(result.user).toContain('buildCards');
      expect(result.user).toContain('./rag/indexer.js');
    });
  });

  // --- Story 29.17: pagePath included in PagePrompt ---
  describe('pagePath in PagePrompt (Story 29.17)', () => {
    it('should include pagePath in the returned prompt', () => {
      const result = buildPagePrompt(
        { path: '05-Modules/rag.md', title: 'RAG', description: 'RAG module' },
        emptyContext,
        samplePkg,
      );

      expect(result.pagePath).toBe('05-Modules/rag.md');
    });

    it('should propagate pagePath for all page types', () => {
      const paths = [
        '01-Getting-Started/01-Overview.md',
        '02-Architecture/01-System-Overview.md',
        '04-API-Reference/01-Public-API.md',
      ];

      for (const path of paths) {
        const result = buildPagePrompt(
          { path, title: 'Test', description: 'Test' },
          emptyContext,
          samplePkg,
        );
        expect(result.pagePath).toBe(path);
      }
    });
  });

  // --- AC6: Model selection ---
  describe('model selection (AC6)', () => {
    it('defaults to haiku model', () => {
      const result = buildPagePrompt(
        { path: '05-Modules/rag.md', title: 'RAG', description: 'RAG module' },
        emptyContext,
        samplePkg,
      );

      expect(result.model).toBe('haiku');
      expect(DEFAULT_MODEL).toBe('haiku');
    });

    it('allows model override', () => {
      const result = buildPagePrompt(
        { path: '05-Modules/rag.md', title: 'RAG', description: 'RAG module' },
        emptyContext,
        samplePkg,
        { model: 'sonnet' },
      );

      expect(result.model).toBe('sonnet');
    });
  });
});
