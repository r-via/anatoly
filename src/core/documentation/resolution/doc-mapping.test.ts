// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { resolveDocMappings, type SourceDir } from './doc-mapping.js';

/**
 * Story 29.5: Code → Documentation Mapping with Fallback
 *
 * Tests validate that resolveDocMappings() correctly maps source
 * directories to documentation pages using a fallback strategy:
 * convention → synonym → framework detection → catch-all.
 */

describe('resolveDocMappings', () => {
  // --- AC1: Synonym matching ---
  describe('synonym matching', () => {
    it('AC: src/api/ maps to REST-Endpoints via synonym (api = routes)', () => {
      const dirs: SourceDir[] = [
        { name: 'api', totalLoc: 500 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings).toHaveLength(1);
      expect(mappings[0].docPage).toBe('04-API-Reference/04-REST-Endpoints.md');
      expect(mappings[0].strategy).toBe('synonym');
    });

    it('handlers maps to REST-Endpoints via synonym (handlers = controllers)', () => {
      const dirs: SourceDir[] = [
        { name: 'handlers', totalLoc: 300 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings).toHaveLength(1);
      expect(mappings[0].docPage).toBe('04-API-Reference/04-REST-Endpoints.md');
      expect(mappings[0].strategy).toBe('synonym');
    });

    it('entities maps to Models via synonym (entities = models)', () => {
      const dirs: SourceDir[] = [
        { name: 'entities', totalLoc: 400 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('05-Modules/Models.md');
      expect(mappings[0].strategy).toBe('synonym');
    });

    it('composables maps to Hooks via synonym (composables = hooks)', () => {
      const dirs: SourceDir[] = [
        { name: 'composables', totalLoc: 250 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('05-Modules/Hooks.md');
      expect(mappings[0].strategy).toBe('synonym');
    });
  });

  // --- Convention matching ---
  describe('convention matching', () => {
    it('routes maps to REST-Endpoints directly', () => {
      const dirs: SourceDir[] = [
        { name: 'routes', totalLoc: 600 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('04-API-Reference/04-REST-Endpoints.md');
      expect(mappings[0].strategy).toBe('convention');
    });

    it('controllers maps to REST-Endpoints directly', () => {
      const dirs: SourceDir[] = [
        { name: 'controllers', totalLoc: 400 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('04-API-Reference/04-REST-Endpoints.md');
      expect(mappings[0].strategy).toBe('convention');
    });

    it('middleware maps to Middleware page', () => {
      const dirs: SourceDir[] = [
        { name: 'middleware', totalLoc: 300 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('04-API-Reference/05-Middleware.md');
      expect(mappings[0].strategy).toBe('convention');
    });

    it('commands maps to CLI-Reference page', () => {
      const dirs: SourceDir[] = [
        { name: 'commands', totalLoc: 500 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('04-API-Reference/04-CLI-Reference.md');
      expect(mappings[0].strategy).toBe('convention');
    });

    it('components maps to Components module page', () => {
      const dirs: SourceDir[] = [
        { name: 'components', totalLoc: 800 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('05-Modules/Components.md');
      expect(mappings[0].strategy).toBe('convention');
    });

    it('hooks maps to Hooks module page', () => {
      const dirs: SourceDir[] = [
        { name: 'hooks', totalLoc: 300 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('05-Modules/Hooks.md');
      expect(mappings[0].strategy).toBe('convention');
    });

    it('services maps to Services module page', () => {
      const dirs: SourceDir[] = [
        { name: 'services', totalLoc: 600 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('05-Modules/Services.md');
      expect(mappings[0].strategy).toBe('convention');
    });

    it('models maps to Models module page', () => {
      const dirs: SourceDir[] = [
        { name: 'models', totalLoc: 400 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('05-Modules/Models.md');
      expect(mappings[0].strategy).toBe('convention');
    });
  });

  // --- AC2: Framework detection ---
  describe('framework detection', () => {
    it('AC: @Controller() decorators map to REST-Endpoints', () => {
      const dirs: SourceDir[] = [
        {
          name: 'user-handlers',
          totalLoc: 400,
          filePatterns: ['@Controller()'],
        },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings).toHaveLength(1);
      expect(mappings[0].docPage).toBe('04-API-Reference/04-REST-Endpoints.md');
      expect(mappings[0].strategy).toBe('framework');
    });

    it('@Injectable() decorators map to Services', () => {
      const dirs: SourceDir[] = [
        {
          name: 'business-logic',
          totalLoc: 500,
          filePatterns: ['@Injectable()'],
        },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('05-Modules/Services.md');
      expect(mappings[0].strategy).toBe('framework');
    });

    it('express.Router() maps to REST-Endpoints', () => {
      const dirs: SourceDir[] = [
        {
          name: 'http',
          totalLoc: 350,
          filePatterns: ['express.Router()'],
        },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('04-API-Reference/04-REST-Endpoints.md');
      expect(mappings[0].strategy).toBe('framework');
    });
  });

  // --- AC3: Catch-all ---
  describe('catch-all fallback', () => {
    it('AC: src/data-layer/ (non-standard, > 200 LOC) → 05-Modules/data-layer.md', () => {
      const dirs: SourceDir[] = [
        { name: 'data-layer', totalLoc: 500 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings).toHaveLength(1);
      expect(mappings[0].docPage).toBe('05-Modules/data-layer.md');
      expect(mappings[0].strategy).toBe('catch-all');
    });

    it('non-standard name with > 200 LOC gets a module page', () => {
      const dirs: SourceDir[] = [
        { name: 'custom-engine', totalLoc: 800 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings[0].docPage).toBe('05-Modules/custom-engine.md');
      expect(mappings[0].strategy).toBe('catch-all');
    });
  });

  // --- AC4: Every dir > 200 LOC has a doc page ---
  describe('coverage guarantee', () => {
    it('AC: every source dir with > 200 LOC total has at least one doc page', () => {
      const dirs: SourceDir[] = [
        { name: 'routes', totalLoc: 600 },
        { name: 'api', totalLoc: 300 },
        { name: 'data-layer', totalLoc: 400 },
        { name: 'tiny-utils', totalLoc: 50 },
      ];

      const mappings = resolveDocMappings(dirs);

      // 3 dirs > 200 LOC → 3 mappings
      expect(mappings).toHaveLength(3);
      const sourceNames = mappings.map(m => m.sourceDir);
      expect(sourceNames).toContain('routes');
      expect(sourceNames).toContain('api');
      expect(sourceNames).toContain('data-layer');
      // tiny-utils excluded (< 200 LOC)
      expect(sourceNames).not.toContain('tiny-utils');
    });
  });

  // --- Dirs below 200 LOC are skipped ---
  describe('LOC threshold', () => {
    it('skips directories with < 200 LOC total', () => {
      const dirs: SourceDir[] = [
        { name: 'helpers', totalLoc: 100 },
        { name: 'constants', totalLoc: 50 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings).toHaveLength(0);
    });

    it('includes directories with exactly 200 LOC', () => {
      const dirs: SourceDir[] = [
        { name: 'utils', totalLoc: 200 },
      ];

      const mappings = resolveDocMappings(dirs);

      expect(mappings).toHaveLength(1);
    });
  });

  // --- Priority order: convention > synonym > framework > catch-all ---
  describe('strategy priority', () => {
    it('convention takes precedence over framework detection', () => {
      const dirs: SourceDir[] = [
        {
          name: 'routes',
          totalLoc: 400,
          filePatterns: ['@Controller()'],
        },
      ];

      const mappings = resolveDocMappings(dirs);

      // Convention match on "routes" should win over framework
      expect(mappings[0].strategy).toBe('convention');
    });
  });

  // --- Edge cases ---
  describe('edge cases', () => {
    it('returns empty array for empty input', () => {
      expect(resolveDocMappings([])).toEqual([]);
    });

    it('handles multiple dirs mapping to the same doc page', () => {
      const dirs: SourceDir[] = [
        { name: 'routes', totalLoc: 300 },
        { name: 'api', totalLoc: 400 },
      ];

      const mappings = resolveDocMappings(dirs);

      // Both map to REST-Endpoints — that's valid
      expect(mappings).toHaveLength(2);
      expect(mappings[0].docPage).toBe('04-API-Reference/04-REST-Endpoints.md');
      expect(mappings[1].docPage).toBe('04-API-Reference/04-REST-Endpoints.md');
    });
  });
});
