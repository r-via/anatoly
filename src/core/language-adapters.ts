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

// --- Bash import extraction helpers ---

const SOURCE_RE = /^(?:source|\.) +["']?([^"'\s]+)["']?/gm;

function extractBashImports(source: string): ImportRef[] {
  const imports: ImportRef[] = [];
  for (const m of source.matchAll(SOURCE_RE)) {
    imports.push({ source: m[1]!, type: 'source' });
  }
  return imports;
}

// --- Bash adapter ---

export class BashAdapter implements LanguageAdapter {
  readonly extensions = ['.sh', '.bash'] as const;
  readonly languageId = 'bash';
  readonly wasmModule = 'bash';

  extractSymbols(rootNode: TSNode): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];

    for (const node of rootNode.namedChildren) {
      if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const name = nameNode.text;
        symbols.push({
          name,
          kind: 'function',
          exported: !name.startsWith('_'),
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
        });
      } else if (node.type === 'variable_assignment') {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const name = nameNode.text;
        const kind = /^[A-Z_][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable';
        symbols.push({
          name,
          kind,
          exported: !name.startsWith('_'),
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
        });
      }
    }

    return symbols;
  }

  extractImports(source: string): ImportRef[] {
    return extractBashImports(source);
  }
}

// --- Python import extraction helpers ---

const PY_IMPORT_ALL_RE = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;

function extractPythonImports(source: string): ImportRef[] {
  const imports: ImportRef[] = [];
  for (const m of source.matchAll(PY_IMPORT_ALL_RE)) {
    const mod = m[1] ?? m[2];
    if (mod) imports.push({ source: mod, type: 'import' });
  }
  return imports;
}

// --- Python adapter ---

export class PythonAdapter implements LanguageAdapter {
  readonly extensions = ['.py'] as const;
  readonly languageId = 'python';
  readonly wasmModule = 'python';

  extractSymbols(rootNode: TSNode): SymbolInfo[] {
    // First pass: detect __all__ if present
    const allNames = this.extractAllNames(rootNode);

    const symbols: SymbolInfo[] = [];
    for (const node of rootNode.namedChildren) {
      this.extractTopLevel(node, symbols, allNames);
    }
    return symbols;
  }

  extractImports(source: string): ImportRef[] {
    return extractPythonImports(source);
  }

  /** Extract names from __all__ = ['name1', 'name2'] if present. */
  private extractAllNames(rootNode: TSNode): Set<string> | null {
    for (const node of rootNode.namedChildren) {
      if (node.type !== 'expression_statement') continue;
      const assignment = node.namedChildren.find((c) => c.type === 'assignment');
      if (!assignment) continue;
      const left = assignment.childForFieldName('left');
      if (!left || left.text !== '__all__') continue;
      const right = assignment.childForFieldName('right');
      if (!right) continue;
      // Parse list of string literals from text
      const names = new Set<string>();
      for (const m of right.text.matchAll(/['"]([^'"]+)['"]/g)) {
        names.add(m[1]!);
      }
      return names;
    }
    return null;
  }

  private isExported(name: string, allNames: Set<string> | null): boolean {
    if (allNames) return allNames.has(name);
    return !name.startsWith('_');
  }

  private extractTopLevel(
    node: TSNode,
    symbols: SymbolInfo[],
    allNames: Set<string> | null,
  ): void {
    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      symbols.push({
        name: nameNode.text,
        kind: 'function',
        exported: this.isExported(nameNode.text, allNames),
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });
    } else if (node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      symbols.push({
        name: nameNode.text,
        kind: 'class',
        exported: this.isExported(nameNode.text, allNames),
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });
    } else if (node.type === 'decorated_definition') {
      // Decorated functions/classes: find the actual definition inside
      const def = node.namedChildren.find(
        (c) => c.type === 'function_definition' || c.type === 'class_definition',
      );
      if (def) {
        this.extractTopLevel(def, symbols, allNames);
      }
    } else if (node.type === 'expression_statement') {
      // Assignments: `NAME = value`
      const assignment = node.namedChildren.find((c) => c.type === 'assignment');
      if (!assignment) return;
      const left = assignment.childForFieldName('left');
      if (!left || left.type !== 'identifier') return;
      const name = left.text;
      if (name === '__all__') return; // skip __all__ itself
      const kind = /^[A-Z_][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable';
      symbols.push({
        name,
        kind,
        exported: this.isExported(name, allNames),
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });
    }
  }
}

// --- Adapter registry ---

const adapters: LanguageAdapter[] = [
  new TypeScriptAdapter(),
  new TsxAdapter(),
  new BashAdapter(),
  new PythonAdapter(),
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
