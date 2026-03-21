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
 * One LLM call per page — no batching. Default model: Haiku.
 */

import type { PageContext, SymbolContext } from './source-context.js';

export const DEFAULT_MODEL = 'haiku';

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
  const parts: string[] = [BASE_SYSTEM_PROMPT];

  if (pagePath.startsWith('02-Architecture/')) {
    parts.push(ARCHITECTURE_INSTRUCTIONS);
  }

  if (pagePath.startsWith('04-API-Reference/')) {
    parts.push(API_REFERENCE_INSTRUCTIONS);
  }

  return parts.join('\n\n');
}

const BASE_SYSTEM_PROMPT = `You are a technical documentation writer for a TypeScript project.
Generate complete Markdown documentation for the requested page.

Follow this template structure:

# {Page Title}

> blockquote: One-line summary describing the page's purpose.

## Overview
Brief introduction and context.

## {Content Sections}
Detailed documentation appropriate for the page type.

## Examples
At least one complete, copy-pasteable code example using real function names from the project.

## See Also
- Links to related documentation pages in the same documentation set.

Rules:
- Use the real function names, types, and file paths provided in the source context.
- Include at least 1 code example per page with realistic arguments.
- All code blocks must specify the language (typescript, bash, etc.).
- Output only the Markdown content, no meta-commentary.`;

const ARCHITECTURE_INSTRUCTIONS = `Architecture Page Requirements:
- Include at least 1 Mermaid diagram (flowchart, sequence, or ER diagram).
- Use real component/module names from the codebase in the diagram.
- Show actual data flow and relationships between modules based on the import graph.`;

const API_REFERENCE_INSTRUCTIONS = `API Reference Page Requirements:
- Each documented function/endpoint must include at least 1 complete usage example.
- Examples must use realistic arguments AND show expected output/response.
- Examples must be copy-pasteable and use real function names from the project.`;

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
