// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Source Code Analysis for Documentation — Story 29.7
 *
 * Extracts relevant source code context for each scaffolded doc page
 * so the LLM can generate accurate, concrete documentation.
 *
 * Extraction includes:
 * - Exported symbols with signatures, JSDoc, and body snippets
 * - Re-exports (named and star)
 * - Import graph (for architecture pages)
 * - File tree
 *
 * Context is truncated by priority when it exceeds the token limit:
 * 1. Exported signatures (highest priority — always kept)
 * 2. Body snippets (medium priority)
 * 3. Internal helpers (lowest priority — removed first)
 */

import type { SymbolInfo, SymbolKind } from '../schemas/task.js';

const DEFAULT_MAX_TOKENS = 8000;
const BODY_SNIPPET_LINES = 20;

// --- Public interfaces ---

export interface SourceFile {
  path: string;
  content: string;
  symbols: SymbolInfo[];
}

export interface SymbolContext {
  name: string;
  kind: SymbolKind;
  signature: string;
  jsdoc: string | null;
  bodySnippet: string;
  filePath: string;
}

export interface ReExportEntry {
  name: string;
  sourceModule: string;
}

export interface ImportEdge {
  from: string;
  to: string;
  symbols: string[];
}

export interface PageContext {
  fileTree: string;
  exports: SymbolContext[];
  internals: SymbolContext[];
  reExports: ReExportEntry[];
  importGraph: ImportEdge[];
  tokenCount: number;
  truncated: boolean;
}

// --- Main entry point ---

/**
 * Builds the source code context for a scaffolded documentation page.
 * Extracts exported symbols, re-exports, and import graph based on page type.
 * Applies token-based truncation with priority ordering.
 */
export function buildPageContext(
  pagePath: string,
  sourceFiles: SourceFile[],
  options?: { maxTokens?: number },
): PageContext {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const isArchitecturePage = pagePath.startsWith('02-Architecture/');

  const fileTree = buildFileTree(sourceFiles);
  const exports: SymbolContext[] = [];
  const internals: SymbolContext[] = [];
  const reExports: ReExportEntry[] = [];

  for (const file of sourceFiles) {
    reExports.push(...extractReExports(file.content));

    for (const sym of file.symbols) {
      const symCtx: SymbolContext = {
        name: sym.name,
        kind: sym.kind,
        signature: extractSignature(file.content, sym),
        jsdoc: extractJsdoc(file.content, sym),
        bodySnippet: extractBodySnippet(file.content, sym, BODY_SNIPPET_LINES),
        filePath: file.path,
      };

      if (sym.exported) {
        exports.push(symCtx);
      } else {
        internals.push(symCtx);
      }
    }
  }

  const importGraph = isArchitecturePage ? extractImportGraph(sourceFiles) : [];

  const context: PageContext = {
    fileTree,
    exports,
    internals,
    reExports,
    importGraph,
    tokenCount: 0,
    truncated: false,
  };

  return applyTruncation(context, maxTokens);
}

// --- Extraction helpers ---

function buildFileTree(sourceFiles: SourceFile[]): string {
  if (sourceFiles.length === 0) return '';
  return sourceFiles.map(f => f.path).sort().join('\n');
}

function extractSignature(content: string, symbol: SymbolInfo): string {
  const lines = content.split('\n');
  const idx = symbol.line_start - 1;
  if (idx < 0 || idx >= lines.length) return symbol.name;

  let line = lines[idx].trim();

  // Remove opening brace and trailing content
  const braceIdx = line.lastIndexOf('{');
  if (braceIdx > 0) {
    line = line.substring(0, braceIdx).trim();
  }

  return line;
}

function extractJsdoc(content: string, symbol: SymbolInfo): string | null {
  const lines = content.split('\n');
  const startIdx = symbol.line_start - 1;

  if (startIdx <= 0) return null;

  let endLine = -1;
  let startLine = -1;

  for (let i = startIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();

    if (trimmed === '') {
      if (endLine === -1) continue; // Skip blank lines before JSDoc
      else break; // Blank line inside JSDoc block
    }

    if (endLine === -1) {
      // Looking for closing */
      if (trimmed.endsWith('*/')) {
        endLine = i;
        if (trimmed.startsWith('/**')) {
          startLine = i; // Single-line JSDoc
          break;
        }
      } else {
        break; // Not a JSDoc block
      }
    } else {
      // Looking for opening /**
      if (trimmed.startsWith('/**')) {
        startLine = i;
        break;
      } else if (trimmed.startsWith('*')) {
        continue; // Inside JSDoc body
      } else {
        break; // Not part of JSDoc
      }
    }
  }

  if (startLine >= 0 && endLine >= startLine) {
    return lines.slice(startLine, endLine + 1).join('\n');
  }

  return null;
}

function extractBodySnippet(
  content: string,
  symbol: SymbolInfo,
  maxLines: number,
): string {
  const lines = content.split('\n');
  const startIdx = symbol.line_start - 1;
  const endIdx = Math.min(
    startIdx + maxLines - 1,
    symbol.line_end - 1,
    lines.length - 1,
  );

  return lines.slice(startIdx, endIdx + 1).join('\n');
}

const NAMED_REEXPORT_RE = /export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
const STAR_REEXPORT_RE = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;

function extractReExports(content: string): ReExportEntry[] {
  const entries: ReExportEntry[] = [];

  // Reset regex lastIndex for safety
  NAMED_REEXPORT_RE.lastIndex = 0;
  STAR_REEXPORT_RE.lastIndex = 0;

  let match;
  while ((match = NAMED_REEXPORT_RE.exec(content)) !== null) {
    const names = match[1].split(',').map(n => n.trim().replace(/^type\s+/, ''));
    const sourceModule = match[2];
    for (const name of names) {
      if (name) entries.push({ name, sourceModule });
    }
  }

  while ((match = STAR_REEXPORT_RE.exec(content)) !== null) {
    entries.push({ name: '*', sourceModule: match[1] });
  }

  return entries;
}

const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

function extractImportGraph(sourceFiles: SourceFile[]): ImportEdge[] {
  const edges: ImportEdge[] = [];

  for (const file of sourceFiles) {
    IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = IMPORT_RE.exec(file.content)) !== null) {
      const symbols = match[1]
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      edges.push({
        from: file.path,
        to: match[2],
        symbols,
      });
    }
  }

  return edges;
}

// --- Truncation ---

function serializeContext(ctx: PageContext): string {
  const parts: string[] = [];

  if (ctx.fileTree) {
    parts.push(`## File Tree\n${ctx.fileTree}`);
  }

  for (const exp of ctx.exports) {
    parts.push(serializeSymbol(exp));
  }

  for (const int of ctx.internals) {
    parts.push(serializeSymbol(int));
  }

  for (const re of ctx.reExports) {
    parts.push(`Re-export: ${re.name} from ${re.sourceModule}`);
  }

  for (const edge of ctx.importGraph) {
    parts.push(`Import: ${edge.from} → ${edge.to} [${edge.symbols.join(', ')}]`);
  }

  return parts.join('\n\n');
}

function serializeSymbol(sym: SymbolContext): string {
  const parts: string[] = [];
  if (sym.jsdoc) parts.push(sym.jsdoc);
  parts.push(sym.signature);
  if (sym.bodySnippet) parts.push(sym.bodySnippet);
  return parts.join('\n');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function applyTruncation(ctx: PageContext, maxTokens: number): PageContext {
  let serialized = serializeContext(ctx);
  let tokens = estimateTokens(serialized);

  if (tokens <= maxTokens) {
    return { ...ctx, tokenCount: tokens, truncated: false };
  }

  // Phase 1: Remove internal helpers (lowest priority)
  let result: PageContext = { ...ctx, internals: [] };
  serialized = serializeContext(result);
  tokens = estimateTokens(serialized);

  if (tokens <= maxTokens) {
    return { ...result, tokenCount: tokens, truncated: true };
  }

  // Phase 2: Remove body snippets from exports (medium priority)
  result = {
    ...result,
    exports: result.exports.map(e => ({ ...e, bodySnippet: '' })),
  };
  serialized = serializeContext(result);
  tokens = estimateTokens(serialized);

  if (tokens <= maxTokens) {
    return { ...result, tokenCount: tokens, truncated: true };
  }

  // Phase 3: Remove JSDoc from exports (keep only signatures)
  result = {
    ...result,
    exports: result.exports.map(e => ({ ...e, jsdoc: null })),
  };
  serialized = serializeContext(result);
  tokens = estimateTokens(serialized);

  return { ...result, tokenCount: tokens, truncated: true };
}
