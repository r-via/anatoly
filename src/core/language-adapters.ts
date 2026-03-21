// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Language Adapter Interface & TypeScript Refactor — Story 31.6
 *
 * Provides a clean abstraction for parsing different languages via
 * tree-sitter. Adding a new language is a matter of implementing
 * LanguageAdapter and registering it — no pipeline changes needed.
 */

import type { Node as TSNode } from 'web-tree-sitter';
import type { SymbolInfo, SymbolKind } from '../schemas/task.js';

// --- Public types ---

export interface ImportRef {
  source: string;
  type: 'import' | 'source' | 'require';
}

export interface LanguageAdapter {
  readonly extensions: readonly string[];
  readonly languageId: string;
  readonly wasmModule: string;
  extractSymbols(rootNode: TSNode): SymbolInfo[];
  extractImports(source: string): ImportRef[];
}

// --- TypeScript-specific constants (moved from scanner.ts) ---

const TS_DECLARATION_KINDS: Record<string, SymbolKind> = {
  function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'type',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  method_definition: 'method',
};

function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

function extractDeclaration(
  node: TSNode,
  exported: boolean,
  symbols: SymbolInfo[],
): void {
  if (node.type === 'lexical_declaration') {
    for (const child of node.namedChildren) {
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        if (!nameNode) continue;
        const name = nameNode.text;

        let kind: SymbolKind;
        if (isHookName(name)) {
          kind = 'hook';
        } else if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
          kind = 'constant';
        } else {
          const value = child.childForFieldName('value');
          if (value && (value.type === 'arrow_function' || value.type === 'function')) {
            kind = 'function';
          } else {
            kind = 'variable';
          }
        }

        symbols.push({
          name,
          kind,
          exported,
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
        });
      }
    }
    return;
  }

  const kind = TS_DECLARATION_KINDS[node.type];
  if (!kind) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;

  const finalKind: SymbolKind = kind === 'function' && isHookName(name) ? 'hook' : kind;

  symbols.push({
    name,
    kind: finalKind,
    exported,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
  });
}

// --- Import extraction helpers ---

const IMPORT_RE = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractTsImports(source: string): ImportRef[] {
  const imports: ImportRef[] = [];

  for (const m of source.matchAll(IMPORT_RE)) {
    imports.push({ source: m[1]!, type: 'import' });
  }
  for (const m of source.matchAll(REQUIRE_RE)) {
    imports.push({ source: m[1]!, type: 'require' });
  }

  return imports;
}

// --- Adapter implementations ---

export class TypeScriptAdapter implements LanguageAdapter {
  readonly extensions = ['.ts'] as const;
  readonly languageId = 'typescript';
  readonly wasmModule = 'tree-sitter-typescript/tree-sitter-typescript.wasm';

  extractSymbols(rootNode: TSNode): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];

    for (const node of rootNode.namedChildren) {
      if (node.type === 'export_statement') {
        const declaration = node.namedChildren.find(
          (c: TSNode) => c.type in TS_DECLARATION_KINDS || c.type === 'lexical_declaration',
        );
        if (declaration) {
          extractDeclaration(declaration, true, symbols);
        }
        continue;
      }

      if (node.type in TS_DECLARATION_KINDS) {
        extractDeclaration(node, false, symbols);
      } else if (node.type === 'lexical_declaration') {
        extractDeclaration(node, false, symbols);
      }
    }

    return symbols;
  }

  extractImports(source: string): ImportRef[] {
    return extractTsImports(source);
  }
}

export class TsxAdapter extends TypeScriptAdapter {
  override readonly extensions = ['.tsx'] as const;
  override readonly languageId = 'tsx';
  override readonly wasmModule = 'tree-sitter-typescript/tree-sitter-tsx.wasm';
}

// --- Adapter registry ---

const adapters: LanguageAdapter[] = [
  new TypeScriptAdapter(),
  new TsxAdapter(),
];

export const ADAPTER_REGISTRY = new Map<string, LanguageAdapter>();

for (const adapter of adapters) {
  for (const ext of adapter.extensions) {
    ADAPTER_REGISTRY.set(ext, adapter);
  }
}

export function resolveAdapter(extension: string): LanguageAdapter | null {
  return ADAPTER_REGISTRY.get(extension) ?? null;
}

// --- Heuristic fallback ---

/**
 * Fallback parser for files with no registered adapter.
 * Returns an empty symbol list — full heuristic parsing is Story 31.12.
 */
export function heuristicParse(_source: string): SymbolInfo[] {
  return [];
}
