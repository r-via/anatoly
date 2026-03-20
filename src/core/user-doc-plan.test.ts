// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { resolveUserDocPlan, type DocPageEntry } from './user-doc-plan.js';

/**
 * Story 29.12: User Documentation Plan Resolver
 *
 * Tests validate that resolveUserDocPlan() correctly classifies user
 * doc pages by concept, builds section mappings, normalizes prefixes,
 * and handles flat/hierarchical/missing docs/ structures.
 */

describe('resolveUserDocPlan', () => {
  // --- AC1: Hierarchical structure with subdirectories ---
  describe('hierarchical docs/ structure (AC1)', () => {
    it('builds section mappings from subdirectory names', () => {
      const pages: DocPageEntry[] = [
        { path: 'architecture/rag-engine.md', headContent: '# RAG Engine\n> Architecture overview' },
        { path: 'guides/first-audit.md', headContent: '# First Audit\n> Getting started guide' },
        { path: 'api/commands.md', headContent: '# Commands API\n> CLI commands reference' },
      ];

      const plan = resolveUserDocPlan(pages);

      expect(plan).not.toBeNull();
      expect(plan!.sectionMappings['architecture']).toBe('docs/architecture/');
      expect(plan!.sectionMappings['guides']).toBe('docs/guides/');
      expect(plan!.sectionMappings['api-reference']).toBe('docs/api/');
    });

    it('classifies pages and extracts H1 titles', () => {
      const pages: DocPageEntry[] = [
        { path: 'architecture/rag-engine.md', headContent: '# RAG Engine Architecture' },
      ];

      const plan = resolveUserDocPlan(pages);

      expect(plan!.pages).toHaveLength(1);
      expect(plan!.pages[0].title).toBe('RAG Engine Architecture');
      expect(plan!.pages[0].concept).toBe('architecture');
      expect(plan!.pages[0].path).toBe('docs/architecture/rag-engine.md');
    });
  });

  // --- AC2: Flat docs/ structure ---
  describe('flat docs/ structure (AC2)', () => {
    it('infers concept from file names when no subdirectories', () => {
      const pages: DocPageEntry[] = [
        { path: 'architecture.md', headContent: '# Architecture\n> System design' },
        { path: 'getting-started.md', headContent: '# Getting Started' },
        { path: 'api-reference.md', headContent: '# API Reference' },
      ];

      const plan = resolveUserDocPlan(pages);

      expect(plan).not.toBeNull();
      expect(plan!.pages.find(p => p.path === 'docs/architecture.md')!.concept).toBe('architecture');
      expect(plan!.pages.find(p => p.path === 'docs/getting-started.md')!.concept).toBe('getting-started');
      expect(plan!.pages.find(p => p.path === 'docs/api-reference.md')!.concept).toBe('api-reference');
    });

    it('falls back to H1 content when file name does not match', () => {
      const pages: DocPageEntry[] = [
        { path: 'overview.md', headContent: '# System Architecture\n> How things connect' },
      ];

      const plan = resolveUserDocPlan(pages);

      expect(plan!.pages[0].concept).toBe('architecture');
    });
  });

  // --- AC3: No docs/ directory ---
  describe('no docs/ directory (AC3)', () => {
    it('returns null when no pages provided', () => {
      expect(resolveUserDocPlan([])).toBeNull();
    });
  });

  // --- AC4: Prefix normalization ---
  describe('prefix normalization (AC4)', () => {
    it('normalizes number prefixes (01-) when matching', () => {
      const pages: DocPageEntry[] = [
        { path: '01-architecture/overview.md', headContent: '# System Overview' },
        { path: '02-guides/first-steps.md', headContent: '# First Steps' },
      ];

      const plan = resolveUserDocPlan(pages);

      expect(plan!.sectionMappings['architecture']).toBe('docs/01-architecture/');
      expect(plan!.sectionMappings['guides']).toBe('docs/02-guides/');
    });

    it('normalizes letter prefixes (a-) when matching', () => {
      const pages: DocPageEntry[] = [
        { path: 'a-getting-started/install.md', headContent: '# Installation' },
        { path: 'b-architecture/design.md', headContent: '# Design' },
      ];

      const plan = resolveUserDocPlan(pages);

      expect(plan!.sectionMappings['getting-started']).toBe('docs/a-getting-started/');
      expect(plan!.sectionMappings['architecture']).toBe('docs/b-architecture/');
    });
  });

  // --- Edge cases ---
  describe('edge cases', () => {
    it('classifies unrecognized pages as "other"', () => {
      const pages: DocPageEntry[] = [
        { path: 'random-notes.md', headContent: '# My Random Notes' },
      ];

      const plan = resolveUserDocPlan(pages);

      expect(plan!.pages[0].concept).toBe('other');
    });

    it('handles pages with no H1', () => {
      const pages: DocPageEntry[] = [
        { path: 'architecture/details.md', headContent: 'Some content without heading' },
      ];

      const plan = resolveUserDocPlan(pages);

      expect(plan!.pages[0].title).toBeNull();
      expect(plan!.pages[0].concept).toBe('architecture');
    });

    it('uses custom docsDir prefix', () => {
      const pages: DocPageEntry[] = [
        { path: 'architecture/overview.md', headContent: '# Overview' },
      ];

      const plan = resolveUserDocPlan(pages, 'documentation');

      expect(plan!.sectionMappings['architecture']).toBe('documentation/architecture/');
      expect(plan!.pages[0].path).toBe('documentation/architecture/overview.md');
    });
  });
});
