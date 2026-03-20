// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Documentation Structure Scaffolder — Story 29.2
 *
 * Generates the ideal documentation file structure in .anatoly/docs/
 * based on detected project types. Pages are empty templates with
 * H1 + summary blockquote. Existing pages are never overwritten.
 * index.md is always regenerated.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectType } from './project-type-detector.js';

export interface ScaffoldResult {
  pagesCreated: string[];
  pagesSkipped: string[];
  indexRegenerated: boolean;
}

interface PageDef {
  path: string;
  title: string;
  description: string;
  section: string;
}

// --- Base pages (all project types) ---
const BASE_PAGES: PageDef[] = [
  // 01-Getting-Started
  { path: '01-Getting-Started/01-Overview.md', title: 'Overview', description: 'What the project does and why it exists', section: 'Getting Started' },
  { path: '01-Getting-Started/02-Installation.md', title: 'Installation', description: 'Prerequisites, install steps, first run', section: 'Getting Started' },
  { path: '01-Getting-Started/03-Configuration.md', title: 'Configuration', description: 'Config files, environment variables, options', section: 'Getting Started' },
  { path: '01-Getting-Started/04-Quick-Start.md', title: 'Quick Start', description: 'End-to-end tutorial in under 5 minutes', section: 'Getting Started' },
  // 02-Architecture
  { path: '02-Architecture/01-System-Overview.md', title: 'System Overview', description: 'High-level diagram and component responsibilities', section: 'Architecture' },
  { path: '02-Architecture/02-Core-Concepts.md', title: 'Core Concepts', description: 'Glossary and key domain concepts', section: 'Architecture' },
  { path: '02-Architecture/03-Data-Flow.md', title: 'Data Flow', description: 'How data moves through the system', section: 'Architecture' },
  { path: '02-Architecture/04-Design-Decisions.md', title: 'Design Decisions', description: 'Architecture Decision Records (ADRs)', section: 'Architecture' },
  // 03-Guides
  { path: '03-Guides/01-Common-Workflows.md', title: 'Common Workflows', description: 'Step-by-step guides for frequent use cases', section: 'Guides' },
  { path: '03-Guides/02-Advanced-Configuration.md', title: 'Advanced Configuration', description: 'Tuning, overrides, advanced options', section: 'Guides' },
  { path: '03-Guides/03-Troubleshooting.md', title: 'Troubleshooting', description: 'Common errors, diagnostics, FAQ', section: 'Guides' },
  // 04-API-Reference
  { path: '04-API-Reference/01-Public-API.md', title: 'Public API', description: 'Exported functions, classes, and their signatures', section: 'API Reference' },
  { path: '04-API-Reference/02-Configuration-Schema.md', title: 'Configuration Schema', description: 'Complete config schema with defaults and validation', section: 'API Reference' },
  { path: '04-API-Reference/03-Types-and-Interfaces.md', title: 'Types and Interfaces', description: 'Public TypeScript types and interfaces', section: 'API Reference' },
  // 06-Development
  { path: '06-Development/01-Source-Tree.md', title: 'Source Tree', description: 'Annotated source tree with module descriptions', section: 'Development' },
  { path: '06-Development/02-Build-and-Test.md', title: 'Build and Test', description: 'Build, test, lint, local CI', section: 'Development' },
  { path: '06-Development/03-Code-Conventions.md', title: 'Code Conventions', description: 'Style guide, patterns, anti-patterns', section: 'Development' },
  { path: '06-Development/04-Release-Process.md', title: 'Release Process', description: 'Versioning, release, publishing', section: 'Development' },
];

// --- Type-specific additional pages ---

const CLI_PAGES: PageDef[] = [
  { path: '04-API-Reference/04-CLI-Reference.md', title: 'CLI Reference', description: 'Command-line interface commands and options', section: 'API Reference' },
];

const FRONTEND_PAGES: PageDef[] = [
  { path: '03-Guides/04-Component-Patterns.md', title: 'Component Patterns', description: 'Reusable component patterns and best practices', section: 'Guides' },
  { path: '03-Guides/05-State-Management.md', title: 'State Management', description: 'Application state management approach', section: 'Guides' },
  { path: '03-Guides/06-Routing.md', title: 'Routing', description: 'Client-side routing setup and patterns', section: 'Guides' },
  { path: '04-API-Reference/04-Component-API.md', title: 'Component API', description: 'Component props, events, and slots reference', section: 'API Reference' },
  { path: '05-Modules/Components.md', title: 'Components', description: 'UI component library reference', section: 'Modules' },
  { path: '05-Modules/Hooks.md', title: 'Hooks', description: 'Custom hooks and composables', section: 'Modules' },
  { path: '05-Modules/Stores.md', title: 'Stores', description: 'State stores and data management', section: 'Modules' },
  { path: '05-Modules/Styles.md', title: 'Styles', description: 'Styling system and theme configuration', section: 'Modules' },
];

const BACKEND_API_PAGES: PageDef[] = [
  { path: '03-Guides/04-Authentication.md', title: 'Authentication', description: 'Authentication flow and security setup', section: 'Guides' },
  { path: '03-Guides/05-Error-Handling.md', title: 'Error Handling', description: 'Error handling strategy and error codes', section: 'Guides' },
  { path: '03-Guides/06-Pagination-and-Filtering.md', title: 'Pagination and Filtering', description: 'Query pagination and filtering patterns', section: 'Guides' },
  { path: '04-API-Reference/04-REST-Endpoints.md', title: 'REST Endpoints', description: 'HTTP endpoint reference with request/response schemas', section: 'API Reference' },
  { path: '04-API-Reference/05-Middleware.md', title: 'Middleware', description: 'Request middleware chain and configuration', section: 'API Reference' },
  { path: '05-Modules/Routes.md', title: 'Routes', description: 'Route handlers and URL structure', section: 'Modules' },
  { path: '05-Modules/Services.md', title: 'Services', description: 'Business logic service layer', section: 'Modules' },
  { path: '05-Modules/Validators.md', title: 'Validators', description: 'Input validation schemas and rules', section: 'Modules' },
  { path: '05-Modules/DTOs.md', title: 'DTOs', description: 'Data Transfer Objects and API payloads', section: 'Modules' },
];

const ORM_PAGES: PageDef[] = [
  { path: '02-Architecture/05-Data-Model.md', title: 'Data Model', description: 'Database schema and entity relationships', section: 'Architecture' },
  { path: '03-Guides/07-Migrations.md', title: 'Migrations', description: 'Database migration workflow', section: 'Guides' },
  { path: '03-Guides/08-Seeding.md', title: 'Seeding', description: 'Database seed data for development and testing', section: 'Guides' },
  { path: '03-Guides/09-Query-Patterns.md', title: 'Query Patterns', description: 'Common database query patterns and optimization', section: 'Guides' },
  { path: '05-Modules/Models.md', title: 'Models', description: 'Database models and entity definitions', section: 'Modules' },
  { path: '05-Modules/Migrations.md', title: 'Migrations', description: 'Migration files and schema history', section: 'Modules' },
];

const MONOREPO_PAGES: PageDef[] = [
  { path: '00-Monorepo/01-Package-Overview.md', title: 'Package Overview', description: 'Packages in this monorepo and their responsibilities', section: 'Monorepo' },
  { path: '00-Monorepo/02-Dependency-Graph.md', title: 'Dependency Graph', description: 'Inter-package dependencies and build order', section: 'Monorepo' },
  { path: '00-Monorepo/03-Shared-Conventions.md', title: 'Shared Conventions', description: 'Cross-package coding standards and shared config', section: 'Monorepo' },
];

const TYPE_PAGES: Record<string, PageDef[]> = {
  CLI: CLI_PAGES,
  Frontend: FRONTEND_PAGES,
  'Backend API': BACKEND_API_PAGES,
  ORM: ORM_PAGES,
  Monorepo: MONOREPO_PAGES,
};

/**
 * Scaffolds the ideal documentation structure in the given output directory.
 *
 * - Creates the base structure (01-Getting-Started through 06-Development)
 * - Adds type-specific pages based on detected project types
 * - Never overwrites existing pages
 * - Always regenerates index.md
 */
export function scaffoldDocs(
  outputDir: string,
  projectTypes: ProjectType[],
  packageJson: Record<string, unknown>,
): ScaffoldResult {
  const projectName = (packageJson['name'] as string) || 'Project';

  // Build the full page list
  const allPages = buildPageList(projectTypes);

  const pagesCreated: string[] = [];
  const pagesSkipped: string[] = [];

  // Create each page (skip existing)
  for (const page of allPages) {
    const fullPath = join(outputDir, page.path);
    if (existsSync(fullPath)) {
      pagesSkipped.push(page.path);
      continue;
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, buildPageContent(page));
    pagesCreated.push(page.path);
  }

  // Always regenerate index.md
  const indexPath = join(outputDir, 'index.md');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(indexPath, buildIndexContent(projectName, allPages));
  if (!pagesCreated.includes('index.md')) {
    pagesCreated.push('index.md');
  }

  return { pagesCreated, pagesSkipped, indexRegenerated: true };
}

// --- Internal helpers ---

function buildPageList(projectTypes: ProjectType[]): PageDef[] {
  const pages = [...BASE_PAGES];
  for (const type of projectTypes) {
    const extra = TYPE_PAGES[type];
    if (extra) {
      pages.push(...extra);
    }
  }
  return pages;
}

function buildPageContent(page: PageDef): string {
  return `# ${page.title}\n\n> ${page.description}\n`;
}

function buildIndexContent(projectName: string, pages: PageDef[]): string {
  const lines: string[] = [];
  lines.push(`# ${projectName} — Documentation\n`);
  lines.push('> Project documentation reference\n');
  lines.push('---\n');

  // Group pages by section, preserving order
  const sections = new Map<string, PageDef[]>();
  for (const page of pages) {
    const existing = sections.get(page.section);
    if (existing) {
      existing.push(page);
    } else {
      sections.set(page.section, [page]);
    }
  }

  // Section number mapping
  const sectionNumbers: Record<string, string> = {
    'Monorepo': '0',
    'Getting Started': '1',
    'Architecture': '2',
    'Guides': '3',
    'API Reference': '4',
    'Modules': '5',
    'Development': '6',
  };

  for (const [section, sectionPages] of sections) {
    const num = sectionNumbers[section] ?? '';
    lines.push(`## ${num}. ${section}\n`);
    lines.push('| Document | Description |');
    lines.push('|----------|-------------|');
    for (const page of sectionPages) {
      lines.push(`| [${page.title}](${page.path}) | ${page.description} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
