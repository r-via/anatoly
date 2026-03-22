// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * LLM Page Content Generation — Story 29.8
 *
 * Builds prompts for LLM-based documentation generation.
 * Each page gets a tailored system prompt (template + page-type rules)
 * and a user message (source context + project metadata).
 *
 * One LLM call per page — no batching. Default model: Sonnet.
 */

import type { PageContext, SymbolContext } from './source-context.js';
import { resolveSystemPrompt } from './prompt-resolver.js';

export const DEFAULT_MODEL = 'sonnet';

// --- Public interfaces ---

export interface PageInfo {
  path: string;
  title: string;
  description: string;
}

export interface PagePrompt {
  pagePath: string;
  system: string;
  user: string;
  model: string;
}

// --- Main entry point ---

/**
 * Builds the system + user prompt for LLM documentation generation.
 * Prompt content varies by page type (architecture, API reference, etc.).
 */
export function buildPagePrompt(
  page: PageInfo,
  pageContext: PageContext,
  packageJson: Record<string, unknown>,
  options?: { model?: string },
): PagePrompt {
  const model = options?.model ?? DEFAULT_MODEL;
  const system = buildSystemPrompt(page.path);
  const user = buildUserMessage(page, pageContext, packageJson);
  return { pagePath: page.path, system, user, model };
}

// --- System prompt ---

function buildSystemPrompt(pagePath: string): string {
  const base = resolveSystemPrompt('doc-generation');
  const parts: string[] = [base];

  if (pagePath.startsWith('02-Architecture/')) {
    parts.push(resolveSystemPrompt('doc-generation.architecture'));
  }

  if (pagePath.startsWith('04-API-Reference/')) {
    parts.push(resolveSystemPrompt('doc-generation.api-reference'));
  }

  return parts.join('\n\n');
}

// --- User message ---

function buildUserMessage(
  page: PageInfo,
  ctx: PageContext,
  pkg: Record<string, unknown>,
): string {
  const parts: string[] = [];

  // Page metadata
  parts.push(`## Page: ${page.title}`);
  parts.push(`Path: ${page.path}`);
  parts.push(`Description: ${page.description}`);

  // Project metadata
  parts.push(`\n## Project`);
  parts.push(`Name: ${String(pkg.name ?? 'unknown')}`);
  if (pkg.description) parts.push(`Description: ${String(pkg.description)}`);
  if (pkg.version) parts.push(`Version: ${String(pkg.version)}`);

  // Install command
  const pkgName = pkg.name ? String(pkg.name) : null;
  if (pkgName) {
    parts.push(`\nInstall: npm install ${pkgName}`);
  }

  // CLI entry points
  if (pkg.bin && typeof pkg.bin === 'object') {
    const bin = pkg.bin as Record<string, string>;
    const entries = Object.entries(bin);
    if (entries.length > 0) {
      parts.push('\nCLI Entry Points:');
      for (const [name, binPath] of entries) {
        parts.push(`  - ${name}: ${binPath}`);
      }
    }
  }

  // Prerequisites: runtime, engines, peer dependencies
  const prerequisites: string[] = [];
  if (pkg.engines && typeof pkg.engines === 'object') {
    for (const [engine, version] of Object.entries(pkg.engines as Record<string, string>)) {
      prerequisites.push(`${engine} ${version}`);
    }
  }
  if (pkg.peerDependencies && typeof pkg.peerDependencies === 'object') {
    for (const [dep, version] of Object.entries(pkg.peerDependencies as Record<string, string>)) {
      prerequisites.push(`${dep} ${version} (peer)`);
    }
  }
  // Key dependencies (not devDeps) — gives context for what the project relies on
  if (pkg.dependencies && typeof pkg.dependencies === 'object') {
    const deps = Object.keys(pkg.dependencies as Record<string, string>);
    if (deps.length > 0) {
      parts.push(`\nDependencies (${deps.length}): ${deps.join(', ')}`);
    }
  }
  if (prerequisites.length > 0) {
    parts.push(`\nPrerequisites: ${prerequisites.join(', ')}`);
  }
  // Scripts — shows available commands
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    const scripts = Object.entries(pkg.scripts as Record<string, string>);
    if (scripts.length > 0) {
      parts.push('\nPackage Scripts:');
      for (const [name, cmd] of scripts) {
        parts.push(`  - ${name}: ${cmd}`);
      }
    }
  }

  // File tree
  if (ctx.fileTree) {
    parts.push(`\n## Source Files\n${ctx.fileTree}`);
  }

  // Exported symbols
  if (ctx.exports.length > 0) {
    parts.push('\n## Exported Symbols');
    for (const sym of ctx.exports) {
      parts.push(formatSymbol(sym));
    }
  }

  // Re-exports
  if (ctx.reExports.length > 0) {
    parts.push('\n## Re-exports');
    for (const re of ctx.reExports) {
      parts.push(`  - ${re.name} from ${re.sourceModule}`);
    }
  }

  // Import graph
  if (ctx.importGraph.length > 0) {
    parts.push('\n## Import Graph');
    for (const edge of ctx.importGraph) {
      parts.push(`  ${edge.from} → ${edge.to} [${edge.symbols.join(', ')}]`);
    }
  }

  return parts.join('\n');
}

function formatSymbol(sym: SymbolContext): string {
  const header = `\n### ${sym.name} (${sym.kind}) — ${sym.filePath}`;
  const parts: string[] = [header];

  if (sym.jsdoc) {
    parts.push(sym.jsdoc);
  }

  parts.push('```typescript');
  parts.push(sym.signature);
  parts.push('```');

  if (sym.bodySnippet) {
    parts.push('Body (first 20 lines):');
    parts.push('```typescript');
    parts.push(sym.bodySnippet);
    parts.push('```');
  }

  return parts.join('\n');
}
