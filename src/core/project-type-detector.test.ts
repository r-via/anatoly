// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { detectProjectTypes, type ProjectType } from './project-type-detector.js';

/**
 * Story 29.1: Project Type Detection
 *
 * Tests validate that detectProjectTypes() correctly identifies project types
 * from package.json content using a decision tree approach.
 * Multiple types can be detected simultaneously.
 */

// Helper to create a minimal package.json structure
function pkg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'test-project', version: '1.0.0', ...overrides };
}

describe('detectProjectTypes', () => {
  // --- AC: Frontend detection ---
  describe('Frontend detection', () => {
    it('detects react in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { react: '^18.0.0' } }));
      expect(result).toContain('Frontend');
    });

    it('detects vue in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { vue: '^3.0.0' } }));
      expect(result).toContain('Frontend');
    });

    it('detects next in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { next: '^14.0.0' } }));
      expect(result).toContain('Frontend');
    });

    it('detects nuxt in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { nuxt: '^3.0.0' } }));
      expect(result).toContain('Frontend');
    });

    it('detects angular in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { '@angular/core': '^17.0.0' } }));
      expect(result).toContain('Frontend');
    });

    it('detects svelte in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { svelte: '^4.0.0' } }));
      expect(result).toContain('Frontend');
    });

    it('detects solid-js in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { 'solid-js': '^1.0.0' } }));
      expect(result).toContain('Frontend');
    });

    it('detects frontend frameworks in devDependencies too', () => {
      const result = detectProjectTypes(pkg({ devDependencies: { react: '^18.0.0' } }));
      expect(result).toContain('Frontend');
    });
  });

  // --- AC: Backend API detection ---
  describe('Backend API detection', () => {
    it('detects express', () => {
      const result = detectProjectTypes(pkg({ dependencies: { express: '^4.0.0' } }));
      expect(result).toContain('Backend API');
    });

    it('detects fastify', () => {
      const result = detectProjectTypes(pkg({ dependencies: { fastify: '^4.0.0' } }));
      expect(result).toContain('Backend API');
    });

    it('detects nestjs', () => {
      const result = detectProjectTypes(pkg({ dependencies: { '@nestjs/core': '^10.0.0' } }));
      expect(result).toContain('Backend API');
    });

    it('detects hono', () => {
      const result = detectProjectTypes(pkg({ dependencies: { hono: '^3.0.0' } }));
      expect(result).toContain('Backend API');
    });

    it('detects koa', () => {
      const result = detectProjectTypes(pkg({ dependencies: { koa: '^2.0.0' } }));
      expect(result).toContain('Backend API');
    });

    it('detects @hapi/hapi', () => {
      const result = detectProjectTypes(pkg({ dependencies: { '@hapi/hapi': '^21.0.0' } }));
      expect(result).toContain('Backend API');
    });
  });

  // --- AC: ORM detection ---
  describe('ORM detection', () => {
    it('detects prisma', () => {
      const result = detectProjectTypes(pkg({ dependencies: { prisma: '^5.0.0' } }));
      expect(result).toContain('ORM');
    });

    it('detects @prisma/client', () => {
      const result = detectProjectTypes(pkg({ dependencies: { '@prisma/client': '^5.0.0' } }));
      expect(result).toContain('ORM');
    });

    it('detects drizzle-orm', () => {
      const result = detectProjectTypes(pkg({ dependencies: { 'drizzle-orm': '^0.30.0' } }));
      expect(result).toContain('ORM');
    });

    it('detects typeorm', () => {
      const result = detectProjectTypes(pkg({ dependencies: { typeorm: '^0.3.0' } }));
      expect(result).toContain('ORM');
    });

    it('detects sequelize', () => {
      const result = detectProjectTypes(pkg({ dependencies: { sequelize: '^6.0.0' } }));
      expect(result).toContain('ORM');
    });

    it('detects knex', () => {
      const result = detectProjectTypes(pkg({ dependencies: { knex: '^3.0.0' } }));
      expect(result).toContain('ORM');
    });

    it('detects @mikro-orm/core', () => {
      const result = detectProjectTypes(pkg({ dependencies: { '@mikro-orm/core': '^5.0.0' } }));
      expect(result).toContain('ORM');
    });
  });

  // --- AC: CLI detection ---
  describe('CLI detection', () => {
    it('detects bin field in package.json', () => {
      const result = detectProjectTypes(pkg({ bin: { 'my-cli': './dist/index.js' } }));
      expect(result).toContain('CLI');
    });

    it('detects bin as string', () => {
      const result = detectProjectTypes(pkg({ bin: './dist/index.js' }));
      expect(result).toContain('CLI');
    });

    it('detects commander in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { commander: '^11.0.0' } }));
      expect(result).toContain('CLI');
    });

    it('detects yargs in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { yargs: '^17.0.0' } }));
      expect(result).toContain('CLI');
    });

    it('detects clipanion in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { clipanion: '^3.0.0' } }));
      expect(result).toContain('CLI');
    });

    it('detects cac in dependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: { cac: '^6.0.0' } }));
      expect(result).toContain('CLI');
    });

    it('AC: bin + commander = CLI', () => {
      const result = detectProjectTypes(pkg({
        bin: { 'my-tool': './dist/index.js' },
        dependencies: { commander: '^11.0.0' },
      }));
      expect(result).toContain('CLI');
    });
  });

  // --- AC: Monorepo detection ---
  describe('Monorepo detection', () => {
    it('detects workspaces field in package.json', () => {
      const result = detectProjectTypes(pkg({ workspaces: ['packages/*'] }));
      expect(result).toContain('Monorepo');
    });

    it('detects workspaces as object (yarn)', () => {
      const result = detectProjectTypes(
        pkg({ workspaces: { packages: ['packages/*'] } }),
      );
      expect(result).toContain('Monorepo');
    });
  });

  // --- AC: Library detection (default) ---
  describe('Library detection (default fallback)', () => {
    it('returns Library when no framework is detected', () => {
      const result = detectProjectTypes(pkg());
      expect(result).toEqual(['Library']);
    });

    it('returns Library for a package with main + types but no framework', () => {
      const result = detectProjectTypes(pkg({
        main: './dist/index.js',
        types: './dist/index.d.ts',
      }));
      expect(result).toEqual(['Library']);
    });

    it('does NOT include Library when a specific type is detected', () => {
      const result = detectProjectTypes(pkg({ dependencies: { react: '^18.0.0' } }));
      expect(result).not.toContain('Library');
    });
  });

  // --- AC: Multiple types detected simultaneously ---
  describe('multiple type combinations', () => {
    it('AC: react + prisma = [Frontend, ORM]', () => {
      const result = detectProjectTypes(pkg({
        dependencies: { react: '^18.0.0', prisma: '^5.0.0' },
      }));
      expect(result).toContain('Frontend');
      expect(result).toContain('ORM');
      expect(result).toHaveLength(2);
    });

    it('Backend API + ORM + CLI', () => {
      const result = detectProjectTypes(pkg({
        bin: { server: './dist/cli.js' },
        dependencies: {
          express: '^4.0.0',
          prisma: '^5.0.0',
        },
      }));
      expect(result).toContain('Backend API');
      expect(result).toContain('ORM');
      expect(result).toContain('CLI');
      expect(result).toHaveLength(3);
    });

    it('Monorepo + other detected types', () => {
      const result = detectProjectTypes(pkg({
        workspaces: ['packages/*'],
        dependencies: { react: '^18.0.0' },
      }));
      expect(result).toContain('Monorepo');
      expect(result).toContain('Frontend');
    });

    it('AC: Monorepo appears first in the result', () => {
      const result = detectProjectTypes(pkg({
        workspaces: ['packages/*'],
        dependencies: { react: '^18.0.0', express: '^4.0.0' },
      }));
      expect(result[0]).toBe('Monorepo');
    });
  });

  // --- Edge cases ---
  describe('edge cases', () => {
    it('handles empty package.json', () => {
      const result = detectProjectTypes({});
      expect(result).toEqual(['Library']);
    });

    it('handles missing dependencies and devDependencies', () => {
      const result = detectProjectTypes(pkg({ dependencies: undefined }));
      expect(result).toEqual(['Library']);
    });

    it('searches both dependencies and devDependencies', () => {
      const result = detectProjectTypes(pkg({
        devDependencies: { prisma: '^5.0.0' },
      }));
      expect(result).toContain('ORM');
    });

    it('does not duplicate types', () => {
      const result = detectProjectTypes(pkg({
        dependencies: { react: '^18.0.0' },
        devDependencies: { next: '^14.0.0' },
      }));
      // Both react and next are Frontend signals — should only appear once
      const frontendCount = result.filter(t => t === 'Frontend').length;
      expect(frontendCount).toBe(1);
    });
  });
});
