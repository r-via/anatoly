// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scaffoldDocs, type ScaffoldResult } from './doc-scaffolder.js';
import type { ProjectType } from './project-type-detector.js';

/**
 * Story 29.2: Documentation Structure Scaffolder
 *
 * Tests validate that scaffoldDocs() creates the correct documentation
 * structure in .anatoly/docs/ based on detected project types.
 */

let tmpDir: string;
let outputDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'anatoly-scaffold-'));
  outputDir = join(tmpDir, '.anatoly', 'docs');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- Base structure pages (all project types) ---
const BASE_PAGES = [
  'index.md',
  '01-Getting-Started/01-Overview.md',
  '01-Getting-Started/02-Installation.md',
  '01-Getting-Started/03-Configuration.md',
  '01-Getting-Started/04-Quick-Start.md',
  '02-Architecture/01-System-Overview.md',
  '02-Architecture/02-Core-Concepts.md',
  '02-Architecture/03-Data-Flow.md',
  '02-Architecture/04-Design-Decisions.md',
  '03-Guides/01-Common-Workflows.md',
  '03-Guides/02-Advanced-Configuration.md',
  '03-Guides/03-Troubleshooting.md',
  '04-API-Reference/01-Public-API.md',
  '04-API-Reference/02-Configuration-Schema.md',
  '04-API-Reference/03-Types-and-Interfaces.md',
  '06-Development/01-Source-Tree.md',
  '06-Development/02-Build-and-Test.md',
  '06-Development/03-Code-Conventions.md',
  '06-Development/04-Release-Process.md',
];

describe('scaffoldDocs', () => {
  describe('base structure (Library / default)', () => {
    it('creates all base pages for a Library project', () => {
      const result = scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      for (const page of BASE_PAGES) {
        expect(existsSync(join(outputDir, page)), `Missing: ${page}`).toBe(true);
      }
    });

    it('returns ScaffoldResult with created pages', () => {
      const result = scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      expect(result.pagesCreated.length).toBeGreaterThanOrEqual(BASE_PAGES.length);
      expect(result.pagesSkipped).toHaveLength(0);
      expect(result.indexRegenerated).toBe(true);
    });

    it('creates index.md with table of contents', () => {
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      const indexContent = readFileSync(join(outputDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('# my-lib');
      expect(indexContent).toContain('Getting Started');
      expect(indexContent).toContain('Architecture');
      expect(indexContent).toContain('Guides');
      expect(indexContent).toContain('API Reference');
      expect(indexContent).toContain('Development');
      // Must contain links to pages
      expect(indexContent).toContain('01-Getting-Started/01-Overview.md');
      expect(indexContent).toContain('06-Development/04-Release-Process.md');
    });

    it('creates pages with basic page template (H1 + summary blockquote)', () => {
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      const overview = readFileSync(
        join(outputDir, '01-Getting-Started/01-Overview.md'),
        'utf-8',
      );
      expect(overview).toMatch(/^# /m); // Has H1
      expect(overview).toContain('>'); // Has blockquote summary
    });
  });

  // --- AC: Backend API + ORM ---
  describe('Backend API + ORM project type', () => {
    const types: ProjectType[] = ['Backend API', 'ORM'];

    it('creates base structure plus Backend API sections', () => {
      scaffoldDocs(outputDir, types, { name: 'my-api' });

      // Backend API additions
      expect(existsSync(join(outputDir, '03-Guides/04-Authentication.md'))).toBe(true);
      expect(existsSync(join(outputDir, '03-Guides/05-Error-Handling.md'))).toBe(true);
      expect(existsSync(join(outputDir, '03-Guides/06-Pagination-and-Filtering.md'))).toBe(true);
      expect(existsSync(join(outputDir, '04-API-Reference/04-REST-Endpoints.md'))).toBe(true);
      expect(existsSync(join(outputDir, '04-API-Reference/05-Middleware.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/Routes.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/Services.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/Validators.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/DTOs.md'))).toBe(true);
    });

    it('creates base structure plus ORM sections', () => {
      scaffoldDocs(outputDir, types, { name: 'my-api' });

      // ORM additions
      expect(existsSync(join(outputDir, '02-Architecture/05-Data-Model.md'))).toBe(true);
      expect(existsSync(join(outputDir, '03-Guides/07-Migrations.md'))).toBe(true);
      expect(existsSync(join(outputDir, '03-Guides/08-Seeding.md'))).toBe(true);
      expect(existsSync(join(outputDir, '03-Guides/09-Query-Patterns.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/Models.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/Migrations.md'))).toBe(true);
    });

    it('includes Backend API and ORM pages in index.md', () => {
      scaffoldDocs(outputDir, types, { name: 'my-api' });

      const indexContent = readFileSync(join(outputDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('04-API-Reference/04-REST-Endpoints.md');
      expect(indexContent).toContain('04-API-Reference/05-Middleware.md');
      expect(indexContent).toContain('02-Architecture/05-Data-Model.md');
      expect(indexContent).toContain('03-Guides/07-Migrations.md');
    });
  });

  // --- AC: Frontend ---
  describe('Frontend project type', () => {
    it('creates base structure plus Frontend sections', () => {
      scaffoldDocs(outputDir, ['Frontend'], { name: 'my-app' });

      // Frontend additions
      expect(existsSync(join(outputDir, '03-Guides/04-Component-Patterns.md'))).toBe(true);
      expect(existsSync(join(outputDir, '03-Guides/05-State-Management.md'))).toBe(true);
      expect(existsSync(join(outputDir, '03-Guides/06-Routing.md'))).toBe(true);
      expect(existsSync(join(outputDir, '04-API-Reference/04-Component-API.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/Components.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/Hooks.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/Stores.md'))).toBe(true);
      expect(existsSync(join(outputDir, '05-Modules/Styles.md'))).toBe(true);
    });

    it('includes Frontend pages in index.md', () => {
      scaffoldDocs(outputDir, ['Frontend'], { name: 'my-app' });

      const indexContent = readFileSync(join(outputDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('04-API-Reference/04-Component-API.md');
      expect(indexContent).toContain('03-Guides/04-Component-Patterns.md');
    });
  });

  // --- CLI ---
  describe('CLI project type', () => {
    it('creates base structure plus CLI Reference', () => {
      scaffoldDocs(outputDir, ['CLI'], { name: 'my-cli' });

      expect(existsSync(join(outputDir, '04-API-Reference/04-CLI-Reference.md'))).toBe(true);
    });

    it('includes CLI Reference in index.md', () => {
      scaffoldDocs(outputDir, ['CLI'], { name: 'my-cli' });

      const indexContent = readFileSync(join(outputDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('04-API-Reference/04-CLI-Reference.md');
    });
  });

  // --- Monorepo ---
  describe('Monorepo project type', () => {
    it('creates 00-Monorepo section', () => {
      scaffoldDocs(outputDir, ['Monorepo'], { name: 'my-monorepo' });

      expect(existsSync(join(outputDir, '00-Monorepo/01-Package-Overview.md'))).toBe(true);
      expect(existsSync(join(outputDir, '00-Monorepo/02-Dependency-Graph.md'))).toBe(true);
      expect(existsSync(join(outputDir, '00-Monorepo/03-Shared-Conventions.md'))).toBe(true);
    });

    it('includes Monorepo section in index.md', () => {
      scaffoldDocs(outputDir, ['Monorepo'], { name: 'my-monorepo' });

      const indexContent = readFileSync(join(outputDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('00-Monorepo/01-Package-Overview.md');
    });
  });

  // --- AC: Idempotency ---
  describe('idempotency (existing pages not overwritten)', () => {
    it('does NOT overwrite existing pages on second run', () => {
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      // Modify an existing page
      const overviewPath = join(outputDir, '01-Getting-Started/01-Overview.md');
      writeFileSync(overviewPath, '# Custom Content\n\nUser-written content here.\n');

      // Run scaffolder again
      const result = scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      // Custom content must be preserved
      const content = readFileSync(overviewPath, 'utf-8');
      expect(content).toContain('User-written content here.');
      expect(result.pagesSkipped).toContain('01-Getting-Started/01-Overview.md');
    });

    it('adds NEW pages when project type changes', () => {
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      // Re-run with additional type
      const result = scaffoldDocs(outputDir, ['CLI'], { name: 'my-lib' });

      expect(existsSync(join(outputDir, '04-API-Reference/04-CLI-Reference.md'))).toBe(true);
      expect(result.pagesCreated).toContain('04-API-Reference/04-CLI-Reference.md');
    });

    it('always regenerates index.md', () => {
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      // Modify index.md
      writeFileSync(join(outputDir, 'index.md'), '# Old index\n');

      // Re-run with CLI type — index should be regenerated with CLI entries
      scaffoldDocs(outputDir, ['CLI'], { name: 'my-lib' });

      const indexContent = readFileSync(join(outputDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('04-API-Reference/04-CLI-Reference.md');
      expect(indexContent).not.toBe('# Old index\n');
    });
  });

  // --- Story 29.3: Scaffolding Hints ---
  describe('scaffolding hints in generated pages', () => {
    it('AC: pages contain <!-- SCAFFOLDING: ... --> comments', () => {
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      const overview = readFileSync(
        join(outputDir, '01-Getting-Started/01-Overview.md'),
        'utf-8',
      );
      expect(overview).toMatch(/<!-- SCAFFOLDING:[\s\S]*?-->/);
    });

    it('AC: each hint includes "Delete this comment when done."', () => {
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      const overview = readFileSync(
        join(outputDir, '01-Getting-Started/01-Overview.md'),
        'utf-8',
      );
      const hints = overview.match(/<!-- SCAFFOLDING:[\s\S]*?-->/g) ?? [];
      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) {
        expect(hint).toContain('Delete this comment when done.');
      }
    });

    it('AC: each hint is max 3 lines', () => {
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      const overview = readFileSync(
        join(outputDir, '01-Getting-Started/01-Overview.md'),
        'utf-8',
      );
      const hints = overview.match(/<!-- SCAFFOLDING:[\s\S]*?-->/g) ?? [];
      for (const hint of hints) {
        // Count lines inside the hint (between <!-- and -->)
        const inner = hint.replace('<!--', '').replace('-->', '').trim();
        const lines = inner.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        expect(lines.length, `Hint too long: ${hint}`).toBeLessThanOrEqual(3);
      }
    });

    it('all non-index pages have at least one SCAFFOLDING hint', () => {
      scaffoldDocs(outputDir, ['Backend API', 'ORM'], { name: 'my-api' });

      // Check a sample of pages across different sections
      const pagesToCheck = [
        '01-Getting-Started/01-Overview.md',
        '02-Architecture/01-System-Overview.md',
        '03-Guides/01-Common-Workflows.md',
        '04-API-Reference/01-Public-API.md',
        '04-API-Reference/04-REST-Endpoints.md',
        '06-Development/01-Source-Tree.md',
        '02-Architecture/05-Data-Model.md',
      ];

      for (const page of pagesToCheck) {
        const content = readFileSync(join(outputDir, page), 'utf-8');
        const hints = content.match(/<!-- SCAFFOLDING:/g) ?? [];
        expect(hints.length, `No hint in ${page}`).toBeGreaterThan(0);
      }
    });

    it('AC: Backend API REST-Endpoints page has project-context-aware hints with sourceHints', () => {
      const sourceHints = new Map<string, string[]>();
      sourceHints.set('04-API-Reference/04-REST-Endpoints.md', [
        'Detected routes: GET /api/users, POST /api/users, GET /api/users/:id',
      ]);

      scaffoldDocs(outputDir, ['Backend API'], { name: 'my-api' }, sourceHints);

      const content = readFileSync(
        join(outputDir, '04-API-Reference/04-REST-Endpoints.md'),
        'utf-8',
      );
      expect(content).toContain('GET /api/users');
      expect(content).toContain('POST /api/users');
    });

    it('AC: previously filled page is NOT overwritten (hints not re-added)', () => {
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      // User fills the page
      const overviewPath = join(outputDir, '01-Getting-Started/01-Overview.md');
      writeFileSync(overviewPath, '# My Custom Overview\n\nReal content here.\n');

      // Run again
      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      // Must preserve user content, not re-add hints
      const content = readFileSync(overviewPath, 'utf-8');
      expect(content).toBe('# My Custom Overview\n\nReal content here.\n');
      expect(content).not.toContain('<!-- SCAFFOLDING:');
    });
  });

  // --- AC: Never writes to docs/ ---
  describe('safety — never writes to docs/', () => {
    it('creates files only under the specified output directory', () => {
      const docsDir = join(tmpDir, 'docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, 'existing.md'), '# Existing doc');

      scaffoldDocs(outputDir, ['Library'], { name: 'my-lib' });

      // docs/ should be untouched
      const docsFiles = readdirRecursive(docsDir);
      expect(docsFiles).toEqual(['existing.md']);
    });
  });
});

/** Recursively list all files relative to a directory. */
function readdirRecursive(dir: string, prefix = ''): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      files.push(...readdirRecursive(full, rel));
    } else {
      files.push(rel);
    }
  }
  return files.sort();
}
