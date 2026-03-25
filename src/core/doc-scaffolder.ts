// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Documentation Structure Scaffolder — Stories 29.2 & 29.3
 *
 * Generates the ideal documentation file structure in .anatoly/docs/
 * based on detected project types. Each page includes contextual
 * SCAFFOLDING hints. Existing pages are never overwritten.
 * index.md is always regenerated.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectType } from './language-detect.js';

export interface ScaffoldResult {
  pagesCreated: string[];
  pagesSkipped: string[];
  /** All pages in the scaffold (created + skipped), for cache mapping. */
  allPages: string[];
  indexRegenerated: boolean;
}

export interface PageDef {
  path: string;
  title: string;
  description: string;
  section: string;
  hint: string;
}

// --- Base pages (all project types) ---
const BASE_PAGES: PageDef[] = [
  // 01-Getting-Started
  { path: '01-Getting-Started/01-Overview.md', title: 'Overview', description: 'What the project does and why it exists', section: 'Getting Started', hint: 'Describe what your project does in 1-2 sentences.\n     Focus on the problem it solves and who it\'s for.' },
  { path: '01-Getting-Started/02-Installation.md', title: 'Installation', description: 'Prerequisites, install steps, first run', section: 'Getting Started', hint: 'List the actual install command (npm/yarn/pnpm) and prerequisites.\n     Include the minimum Node.js version required.' },
  { path: '01-Getting-Started/03-Configuration.md', title: 'Configuration', description: 'Config files, environment variables, options', section: 'Getting Started', hint: 'Document each config file, env variable, and CLI flag.\n     Include defaults and valid values for each option.' },
  { path: '01-Getting-Started/04-Quick-Start.md', title: 'Quick Start', description: 'End-to-end tutorial in under 5 minutes', section: 'Getting Started', hint: 'Write a step-by-step tutorial from install to first result.\n     Keep it under 5 minutes with copy-pasteable commands.' },
  // 02-Architecture
  { path: '02-Architecture/01-System-Overview.md', title: 'System Overview', description: 'High-level diagram and component responsibilities', section: 'Architecture', hint: 'Add a Mermaid diagram showing the main components.\n     List each component with a one-line responsibility.' },
  { path: '02-Architecture/02-Core-Concepts.md', title: 'Core Concepts', description: 'Glossary and key domain concepts', section: 'Architecture', hint: 'Define the key domain terms used throughout the codebase.\n     Each term should have a one-sentence definition.' },
  { path: '02-Architecture/03-Data-Flow.md', title: 'Data Flow', description: 'How data moves through the system', section: 'Architecture', hint: 'Trace data from input to output with a Mermaid sequence diagram.\n     Show the main transformations at each step.' },
  { path: '02-Architecture/04-Design-Decisions.md', title: 'Design Decisions', description: 'Architecture Decision Records (ADRs)', section: 'Architecture', hint: 'Document key architecture decisions using ADR format.\n     Include context, decision, and consequences for each.' },
  // 03-Guides
  { path: '03-Guides/01-Common-Workflows.md', title: 'Common Workflows', description: 'Step-by-step guides for frequent use cases', section: 'Guides', hint: 'List the 3-5 most common tasks users perform.\n     Write a numbered step-by-step guide for each.' },
  { path: '03-Guides/02-Advanced-Configuration.md', title: 'Advanced Configuration', description: 'Tuning, overrides, advanced options', section: 'Guides', hint: 'Document advanced options, performance tuning, and overrides.\n     Include real config snippets with explanations.' },
  { path: '03-Guides/03-Troubleshooting.md', title: 'Troubleshooting', description: 'Common errors, diagnostics, FAQ', section: 'Guides', hint: 'List common errors with their causes and solutions.\n     Use "Problem / Cause / Solution" format for each.' },
  // 04-API-Reference
  { path: '04-API-Reference/01-Public-API.md', title: 'Public API', description: 'Exported functions, classes, and their signatures', section: 'API Reference', hint: 'Document every exported function and class with its signature.\n     Include parameter types, return types, and a usage example.' },
  { path: '04-API-Reference/02-Configuration-Schema.md', title: 'Configuration Schema', description: 'Complete config schema with defaults and validation', section: 'API Reference', hint: 'List every config field with its type, default, and validation rules.\n     Show a complete example config file.' },
  { path: '04-API-Reference/03-Types-and-Interfaces.md', title: 'Types and Interfaces', description: 'Public TypeScript types and interfaces', section: 'API Reference', hint: 'List every exported type and interface with its fields.\n     Group related types together and explain their purpose.' },
  // 06-Development
  { path: '06-Development/01-Source-Tree.md', title: 'Source Tree', description: 'Annotated source tree with module descriptions', section: 'Development', hint: 'Show the src/ directory tree with a one-line description per module.\n     Highlight the entry point and core modules.' },
  { path: '06-Development/02-Build-and-Test.md', title: 'Build and Test', description: 'Build, test, lint, local CI', section: 'Development', hint: 'List all build, test, and lint commands.\n     Include how to run tests locally and check coverage.' },
  { path: '06-Development/03-Code-Conventions.md', title: 'Code Conventions', description: 'Style guide, patterns, anti-patterns', section: 'Development', hint: 'Document naming conventions, file structure rules, and patterns.\n     Include examples of preferred vs. discouraged approaches.' },
  { path: '06-Development/04-Release-Process.md', title: 'Release Process', description: 'Versioning, release, publishing', section: 'Development', hint: 'Describe the versioning scheme and release workflow.\n     Include the steps to publish a new version.' },
];

// --- Type-specific additional pages ---

const CLI_PAGES: PageDef[] = [
  { path: '04-API-Reference/04-CLI-Reference.md', title: 'CLI Reference', description: 'Command-line interface commands and options', section: 'API Reference', hint: 'Document every CLI command with its flags and arguments.\n     Include usage examples for each command.' },
];

const FRONTEND_PAGES: PageDef[] = [
  { path: '03-Guides/04-Component-Patterns.md', title: 'Component Patterns', description: 'Reusable component patterns and best practices', section: 'Guides', hint: 'Document the component patterns used in this project.\n     Include examples of composition, render props, and HOCs.' },
  { path: '03-Guides/05-State-Management.md', title: 'State Management', description: 'Application state management approach', section: 'Guides', hint: 'Explain the state management strategy and data flow.\n     Show how to add a new piece of state.' },
  { path: '03-Guides/06-Routing.md', title: 'Routing', description: 'Client-side routing setup and patterns', section: 'Guides', hint: 'Document the routing setup and how to add new routes.\n     Include route guards, lazy loading, and nested routes.' },
  { path: '04-API-Reference/04-Component-API.md', title: 'Component API', description: 'Component props, events, and slots reference', section: 'API Reference', hint: 'Document each component with its props, events, and slots.\n     Include a usage example for each component.' },
  { path: '05-Modules/Components.md', title: 'Components', description: 'UI component library reference', section: 'Modules', hint: 'List all UI components with their purpose and usage.\n     Group by category (layout, forms, navigation, etc.).' },
  { path: '05-Modules/Hooks.md', title: 'Hooks', description: 'Custom hooks and composables', section: 'Modules', hint: 'Document each custom hook with its signature and return value.\n     Include a usage example showing when to use it.' },
  { path: '05-Modules/Stores.md', title: 'Stores', description: 'State stores and data management', section: 'Modules', hint: 'Document each store with its state shape and actions.\n     Explain the data flow and persistence strategy.' },
  { path: '05-Modules/Styles.md', title: 'Styles', description: 'Styling system and theme configuration', section: 'Modules', hint: 'Document the styling approach, theme tokens, and CSS conventions.\n     Include how to customize or extend the theme.' },
];

const BACKEND_API_PAGES: PageDef[] = [
  { path: '03-Guides/04-Authentication.md', title: 'Authentication', description: 'Authentication flow and security setup', section: 'Guides', hint: 'Describe the authentication flow (JWT, session, OAuth, etc.).\n     Include setup steps and security considerations.' },
  { path: '03-Guides/05-Error-Handling.md', title: 'Error Handling', description: 'Error handling strategy and error codes', section: 'Guides', hint: 'Document the error handling strategy and error response format.\n     List all application-specific error codes.' },
  { path: '03-Guides/06-Pagination-and-Filtering.md', title: 'Pagination and Filtering', description: 'Query pagination and filtering patterns', section: 'Guides', hint: 'Document the pagination format (cursor vs offset) and filter syntax.\n     Include request/response examples.' },
  { path: '04-API-Reference/04-REST-Endpoints.md', title: 'REST Endpoints', description: 'HTTP endpoint reference with request/response schemas', section: 'API Reference', hint: 'Document each endpoint with method, path, request body, and response.\n     Include curl examples for each endpoint.' },
  { path: '04-API-Reference/05-Middleware.md', title: 'Middleware', description: 'Request middleware chain and configuration', section: 'API Reference', hint: 'List each middleware in execution order with its purpose.\n     Document configuration options for each.' },
  { path: '05-Modules/Routes.md', title: 'Routes', description: 'Route handlers and URL structure', section: 'Modules', hint: 'Document the route file organization and URL structure.\n     Show how to add a new route group.' },
  { path: '05-Modules/Services.md', title: 'Services', description: 'Business logic service layer', section: 'Modules', hint: 'Document each service with its public methods and dependencies.\n     Explain the service layer responsibility boundaries.' },
  { path: '05-Modules/Validators.md', title: 'Validators', description: 'Input validation schemas and rules', section: 'Modules', hint: 'Document the validation approach and list validation schemas.\n     Include examples of custom validation rules.' },
  { path: '05-Modules/DTOs.md', title: 'DTOs', description: 'Data Transfer Objects and API payloads', section: 'Modules', hint: 'Document each DTO with its fields, types, and transformations.\n     Show request vs. response DTO differences.' },
];

const ORM_PAGES: PageDef[] = [
  { path: '02-Architecture/05-Data-Model.md', title: 'Data Model', description: 'Database schema and entity relationships', section: 'Architecture', hint: 'Add a Mermaid ER diagram showing all entities and relations.\n     Document each entity with its key fields.' },
  { path: '03-Guides/07-Migrations.md', title: 'Migrations', description: 'Database migration workflow', section: 'Guides', hint: 'Document how to create, run, and rollback migrations.\n     Include the naming convention for migration files.' },
  { path: '03-Guides/08-Seeding.md', title: 'Seeding', description: 'Database seed data for development and testing', section: 'Guides', hint: 'Document how to seed the database for dev and test environments.\n     List the seed data fixtures and their purpose.' },
  { path: '03-Guides/09-Query-Patterns.md', title: 'Query Patterns', description: 'Common database query patterns and optimization', section: 'Guides', hint: 'Document common query patterns with code examples.\n     Include performance tips and N+1 prevention strategies.' },
  { path: '05-Modules/Models.md', title: 'Models', description: 'Database models and entity definitions', section: 'Modules', hint: 'Document each model with its fields, relations, and validation.\n     Include the database table name mapping.' },
  { path: '05-Modules/Migrations.md', title: 'Migrations', description: 'Migration files and schema history', section: 'Modules', hint: 'List migration files chronologically with their changes.\n     Document the current schema version.' },
];

const MONOREPO_PAGES: PageDef[] = [
  { path: '00-Monorepo/01-Package-Overview.md', title: 'Package Overview', description: 'Packages in this monorepo and their responsibilities', section: 'Monorepo', hint: 'List each package with a one-line description and its purpose.\n     Include the dependency relationships between packages.' },
  { path: '00-Monorepo/02-Dependency-Graph.md', title: 'Dependency Graph', description: 'Inter-package dependencies and build order', section: 'Monorepo', hint: 'Add a Mermaid graph showing inter-package dependencies.\n     Document the build order and shared dependencies.' },
  { path: '00-Monorepo/03-Shared-Conventions.md', title: 'Shared Conventions', description: 'Cross-package coding standards and shared config', section: 'Monorepo', hint: 'Document shared linting, testing, and build conventions.\n     List shared config files and their locations.' },
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
 * - Creates the base structure (01-Getting-Started through 05/06-Development)
 * - Adds type-specific pages based on detected project types
 * - Adds dynamic module pages from resolveModuleGranularity (Story 29.16)
 * - Each page includes contextual SCAFFOLDING hints (Story 29.3)
 * - Never overwrites existing pages
 * - Always regenerates index.md
 * - When no 05-Modules/ pages exist, 06-Development is renumbered to 05-Development
 * - Optional sourceHints map provides project-context-aware hints per page
 *
 * @param outputDir   - Absolute path to the target directory (e.g. `.anatoly/docs/`).
 * @param projectTypes - Detected project types used to select type-specific pages.
 * @param packageJson  - Parsed `package.json`; the `name` field is used for the index title.
 * @param sourceHints  - Optional map of page path to extra SCAFFOLDING hint strings
 *                       derived from source analysis.
 * @param dynamicModulePages - Optional additional {@link PageDef} entries from
 *                             `resolveModuleGranularity` (Story 29.16).
 * @returns A {@link ScaffoldResult} listing created pages, skipped pages, and
 *          whether `index.md` was regenerated.
 */
export function scaffoldDocs(
  outputDir: string,
  projectTypes: ProjectType[],
  packageJson: Record<string, unknown>,
  sourceHints?: Map<string, string[]>,
  dynamicModulePages?: PageDef[],
): ScaffoldResult {
  const projectName = (packageJson['name'] as string) || 'Project';

  // Build the full page list (includes dynamic modules + renumbering)
  const allPages = buildPageList(projectTypes, dynamicModulePages);

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
    const extraHints = sourceHints?.get(page.path);
    writeFileSync(fullPath, buildPageContent(page, extraHints));
    pagesCreated.push(page.path);
  }

  // Always regenerate index.md
  const indexPath = join(outputDir, 'index.md');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(indexPath, buildIndexContent(projectName, allPages));
  if (!pagesCreated.includes('index.md')) {
    pagesCreated.push('index.md');
  }

  const allPagePaths = allPages.map(p => p.path);
  if (!allPagePaths.includes('index.md')) allPagePaths.push('index.md');
  return { pagesCreated, pagesSkipped, allPages: allPagePaths, indexRegenerated: true };
}

// --- Internal helpers ---

function buildPageList(projectTypes: ProjectType[], dynamicModulePages: PageDef[] = []): PageDef[] {
  // Deep-copy to avoid mutating the module-level constants
  const pages: PageDef[] = BASE_PAGES.map(p => ({ ...p }));
  for (const type of projectTypes) {
    const extra = TYPE_PAGES[type];
    if (extra) {
      pages.push(...extra.map(p => ({ ...p })));
    }
  }

  // Add dynamic module pages (Story 29.16)
  pages.push(...dynamicModulePages.map(p => ({ ...p })));

  // Renumber 06-Development → 05-Development when no 05-Modules/ pages exist
  const hasModulePages = pages.some(p => p.path.startsWith('05-Modules/'));
  if (!hasModulePages) {
    for (const page of pages) {
      if (page.path.startsWith('06-Development/')) {
        page.path = page.path.replace('06-Development/', '05-Development/');
      }
    }
  }

  return pages;
}

function buildPageContent(page: PageDef, extraHints?: string[]): string {
  const lines: string[] = [];

  lines.push(`# ${page.title}`);
  lines.push('');
  lines.push(`> ${page.description}`);
  lines.push('');

  // Add SCAFFOLDING hint
  lines.push(`<!-- SCAFFOLDING: ${page.hint}`);
  lines.push('     Delete this comment when done. -->');
  lines.push('');

  // Add source-context hints if provided
  if (extraHints && extraHints.length > 0) {
    for (const extra of extraHints) {
      lines.push(`<!-- SCAFFOLDING: ${extra}`);
      lines.push('     Delete this comment when done. -->');
      lines.push('');
    }
  }

  return lines.join('\n');
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

  // Sort sections by their numeric path prefix so the index is ordered correctly
  const sortedSections = [...sections.entries()].sort((a, b) => {
    const numA = parseInt(a[1][0]?.path.match(/^(\d+)-/)?.[1] ?? '99', 10);
    const numB = parseInt(b[1][0]?.path.match(/^(\d+)-/)?.[1] ?? '99', 10);
    return numA - numB;
  });

  for (const [section, sectionPages] of sortedSections) {
    // Derive section number from path prefix (e.g., '05-Development/...' → '5')
    const firstPath = sectionPages[0]?.path ?? '';
    const prefix = firstPath.split('/')[0] ?? '';
    const num = prefix.match(/^(\d+)-/)?.[1]?.replace(/^0+/, '') ?? '';
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
