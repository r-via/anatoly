// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  buildDocRecommendations,
  type DocGap,
  type DocRecommendation,
} from './doc-recommendations.js';
import type { UserDocPlan } from './user-doc-plan.js';

describe('buildDocRecommendations', () => {
  it('returns empty array when no gaps', () => {
    const result = buildDocRecommendations([], null);
    expect(result).toEqual([]);
  });

  // --- missing_page with user plan ---

  it('maps missing_page to user directory via sectionMappings', () => {
    const plan: UserDocPlan = {
      sectionMappings: { architecture: 'docs/architecture/' },
      pages: [],
    };
    const gaps: DocGap[] = [
      {
        type: 'missing_page',
        idealPath: '02-Architecture/01-System-Overview.md',
        rationale: 'No system overview page found',
        priority: 'high',
      },
    ];

    const result = buildDocRecommendations(gaps, plan);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('missing_page');
    expect(result[0].path_ideal).toBe('.anatoly/docs/02-Architecture/01-System-Overview.md');
    expect(result[0].path_user).toBe('docs/architecture/System-Overview.md');
    expect(result[0].content_ref).toBe('.anatoly/docs/02-Architecture/01-System-Overview.md');
    expect(result[0].rationale).toBe('No system overview page found');
    expect(result[0].priority).toBe('high');
  });

  it('maps modules concept to user directory', () => {
    const plan: UserDocPlan = {
      sectionMappings: { modules: 'docs/components/' },
      pages: [],
    };
    const gaps: DocGap[] = [
      {
        type: 'missing_page',
        idealPath: '05-Modules/rag.md',
        rationale: 'Module src/rag/ (4 files, 1200+ LOC) has no dedicated documentation page',
        priority: 'high',
      },
    ];

    const result = buildDocRecommendations(gaps, plan);

    expect(result[0].path_ideal).toBe('.anatoly/docs/05-Modules/rag.md');
    expect(result[0].path_user).toBe('docs/components/rag.md');
    expect(result[0].content_ref).toBe('.anatoly/docs/05-Modules/rag.md');
  });

  // --- missing_page without user plan ---

  it('mirrors ideal path under docs/ when no user plan', () => {
    const gaps: DocGap[] = [
      {
        type: 'missing_page',
        idealPath: '05-Modules/rag.md',
        rationale: 'Module lacks documentation',
        priority: 'high',
      },
    ];

    const result = buildDocRecommendations(gaps, null);

    expect(result[0].path_ideal).toBe('.anatoly/docs/05-Modules/rag.md');
    expect(result[0].path_user).toBe('docs/05-Modules/rag.md');
    expect(result[0].content_ref).toBe('.anatoly/docs/05-Modules/rag.md');
  });

  // --- missing_section with existing user page ---

  it('uses existing user page path for missing_section', () => {
    const gaps: DocGap[] = [
      {
        type: 'missing_section',
        idealPath: '01-Getting-Started/04-Quick-Start.md',
        rationale: 'Getting Started guide missing First Run section',
        priority: 'medium',
        section: '## First Run',
        existingUserPath: 'docs/guides/getting-started.md',
      },
    ];

    const result = buildDocRecommendations(gaps, null);

    expect(result[0].type).toBe('missing_section');
    expect(result[0].path_user).toBe('docs/guides/getting-started.md');
    expect(result[0].section).toBe('## First Run');
    expect(result[0].content_ref).toBe('.anatoly/docs/01-Getting-Started/04-Quick-Start.md');
  });

  // --- outdated_content with existing user page ---

  it('uses existing user page path for outdated_content', () => {
    const gaps: DocGap[] = [
      {
        type: 'outdated_content',
        idealPath: '02-Architecture/03-Data-Flow.md',
        rationale: 'Data flow diagram references removed module',
        priority: 'medium',
        existingUserPath: 'docs/architecture/pipeline.md',
      },
    ];

    const result = buildDocRecommendations(gaps, null);

    expect(result[0].type).toBe('outdated_content');
    expect(result[0].path_user).toBe('docs/architecture/pipeline.md');
  });

  // --- fallback when concept not in sectionMappings ---

  it('falls back to docs/ mirror when concept not in user plan', () => {
    const plan: UserDocPlan = {
      sectionMappings: { guides: 'docs/tutorials/' },
      pages: [],
    };
    const gaps: DocGap[] = [
      {
        type: 'missing_page',
        idealPath: '02-Architecture/01-System-Overview.md',
        rationale: 'No architecture docs',
        priority: 'high',
      },
    ];

    const result = buildDocRecommendations(gaps, plan);

    // architecture not in sectionMappings → falls back to mirror
    expect(result[0].path_user).toBe('docs/02-Architecture/System-Overview.md');
  });

  // --- all required fields present ---

  it('always includes all 6 required fields on every recommendation', () => {
    const gaps: DocGap[] = [
      { type: 'missing_page', idealPath: '05-Modules/scanner.md', rationale: 'r1', priority: 'high' },
      { type: 'empty_page', idealPath: '03-Guides/01-Common-Workflows.md', rationale: 'r2', priority: 'medium' },
      { type: 'broken_link', idealPath: '04-API-Reference/01-Public-API.md', rationale: 'r3', priority: 'low' },
      { type: 'missing_index_entry', idealPath: '05-Modules/cache.md', rationale: 'r4', priority: 'low' },
      { type: 'missing_jsdoc', idealPath: '04-API-Reference/01-Public-API.md', rationale: 'r5', priority: 'medium' },
      { type: 'incomplete_jsdoc', idealPath: '04-API-Reference/01-Public-API.md', rationale: 'r6', priority: 'low' },
    ];

    const result = buildDocRecommendations(gaps, null);

    expect(result).toHaveLength(6);
    for (const rec of result) {
      expect(rec).toHaveProperty('type');
      expect(rec).toHaveProperty('path_ideal');
      expect(rec).toHaveProperty('path_user');
      expect(rec).toHaveProperty('content_ref');
      expect(rec).toHaveProperty('rationale');
      expect(rec).toHaveProperty('priority');
    }
  });

  // --- multiple gaps with mixed types ---

  it('handles multiple gaps preserving order', () => {
    const plan: UserDocPlan = {
      sectionMappings: {
        'getting-started': 'docs/start/',
        modules: 'docs/reference/',
      },
      pages: [],
    };
    const gaps: DocGap[] = [
      { type: 'missing_page', idealPath: '01-Getting-Started/02-Installation.md', rationale: 'r1', priority: 'high' },
      { type: 'missing_page', idealPath: '05-Modules/rag.md', rationale: 'r2', priority: 'high' },
      { type: 'missing_section', idealPath: '01-Getting-Started/04-Quick-Start.md', rationale: 'r3', priority: 'medium', section: '## First Run', existingUserPath: 'docs/start/quickstart.md' },
    ];

    const result = buildDocRecommendations(gaps, plan);

    expect(result).toHaveLength(3);
    expect(result[0].path_user).toBe('docs/start/Installation.md');
    expect(result[1].path_user).toBe('docs/reference/rag.md');
    expect(result[2].path_user).toBe('docs/start/quickstart.md');
  });

  // --- strips ordering prefix from filenames ---

  it('strips ordering prefix from ideal filename in user path', () => {
    const plan: UserDocPlan = {
      sectionMappings: { guides: 'docs/how-to/' },
      pages: [],
    };
    const gaps: DocGap[] = [
      {
        type: 'missing_page',
        idealPath: '03-Guides/01-Common-Workflows.md',
        rationale: 'Missing workflows guide',
        priority: 'medium',
      },
    ];

    const result = buildDocRecommendations(gaps, plan);

    // Should strip "01-" prefix from filename
    expect(result[0].path_user).toBe('docs/how-to/Common-Workflows.md');
  });
});
