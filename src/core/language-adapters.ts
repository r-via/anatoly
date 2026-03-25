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

/**
 * Contract for language-specific tree-sitter adapters.
 * `wasmModule` is null for languages that lack a tree-sitter grammar and rely on heuristic extraction instead.
 */
export interface LanguageAdapter {
  readonly extensions: readonly string[];
  readonly languageId: string;
  readonly wasmModule: string | null;
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
  readonly extensions: readonly string[] = ['.ts'];
  readonly languageId: string = 'typescript';
  readonly wasmModule: string = 'tree-sitter-typescript/tree-sitter-typescript.wasm';

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
  readonly wasmModule = 'tree-sitter-bash/tree-sitter-bash.wasm';

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

/** Python adapter using a two-pass strategy: checks `__all__` for explicit exports, falls back to underscore-prefix convention. */
export class PythonAdapter implements LanguageAdapter {
  readonly extensions = ['.py'] as const;
  readonly languageId = 'python';
  readonly wasmModule = 'tree-sitter-python/tree-sitter-python.wasm';

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

// --- Rust import extraction helpers ---

const RUST_USE_RE = /^use\s+(\S+)\s*;/gm;

function extractRustImports(source: string): ImportRef[] {
  const imports: ImportRef[] = [];
  for (const m of source.matchAll(RUST_USE_RE)) {
    imports.push({ source: m[1]!, type: 'import' });
  }
  return imports;
}

// --- Rust adapter ---

const RUST_SYMBOL_TYPES: Record<string, SymbolKind> = {
  function_item: 'function',
  struct_item: 'class',
  trait_item: 'type',
  enum_item: 'enum',
  const_item: 'constant',
  static_item: 'constant',
};

export class RustAdapter implements LanguageAdapter {
  readonly extensions = ['.rs'] as const;
  readonly languageId = 'rust';
  readonly wasmModule = 'tree-sitter-rust/tree-sitter-rust.wasm';

  extractSymbols(rootNode: TSNode): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    for (const node of rootNode.namedChildren) {
      const kind = RUST_SYMBOL_TYPES[node.type];
      if (!kind) continue;

      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;

      const exported = node.namedChildren.some((c) => c.type === 'visibility_modifier');

      symbols.push({
        name: nameNode.text,
        kind,
        exported,
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });
    }
    return symbols;
  }

  extractImports(source: string): ImportRef[] {
    return extractRustImports(source);
  }
}

// --- Go import extraction helpers ---

function extractGoImports(source: string): ImportRef[] {
  const imports: ImportRef[] = [];

  // Single imports: import "fmt"
  const singleRe = /^import\s+"([^"]+)"/gm;
  for (const m of source.matchAll(singleRe)) {
    imports.push({ source: m[1]!, type: 'import' });
  }

  // Grouped imports: import (\n"fmt"\n"os"\n)
  const groupRe = /^import\s*\(([\s\S]*?)\)/gm;
  for (const m of source.matchAll(groupRe)) {
    const block = m[1]!;
    const pathRe = /"([^"]+)"/g;
    for (const pm of block.matchAll(pathRe)) {
      imports.push({ source: pm[1]!, type: 'import' });
    }
  }

  return imports;
}

// --- Go adapter ---

const GO_TYPE_MAP: Record<string, SymbolKind> = {
  struct_type: 'class',
  interface_type: 'type',
};

function isGoExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

export class GoAdapter implements LanguageAdapter {
  readonly extensions = ['.go'] as const;
  readonly languageId = 'go';
  readonly wasmModule = 'tree-sitter-go/tree-sitter-go.wasm';

  extractSymbols(rootNode: TSNode): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    for (const node of rootNode.namedChildren) {
      if (node.type === 'function_declaration' || node.type === 'method_declaration') {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        symbols.push({
          name: nameNode.text,
          kind: node.type === 'method_declaration' ? 'method' : 'function',
          exported: isGoExported(nameNode.text),
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
        });
      } else if (node.type === 'type_declaration') {
        for (const spec of node.namedChildren) {
          if (spec.type !== 'type_spec') continue;
          const nameNode = spec.childForFieldName('name');
          const typeNode = spec.childForFieldName('type');
          if (!nameNode || !typeNode) continue;
          const kind = GO_TYPE_MAP[typeNode.type] ?? 'type';
          symbols.push({
            name: nameNode.text,
            kind,
            exported: isGoExported(nameNode.text),
            line_start: spec.startPosition.row + 1,
            line_end: spec.endPosition.row + 1,
          });
        }
      } else if (node.type === 'const_declaration') {
        for (const spec of node.namedChildren) {
          if (spec.type !== 'const_spec') continue;
          const nameNode = spec.childForFieldName('name');
          if (!nameNode) continue;
          symbols.push({
            name: nameNode.text,
            kind: 'constant',
            exported: isGoExported(nameNode.text),
            line_start: spec.startPosition.row + 1,
            line_end: spec.endPosition.row + 1,
          });
        }
      }
    }
    return symbols;
  }

  extractImports(source: string): ImportRef[] {
    return extractGoImports(source);
  }
}

// --- Java import extraction helpers ---

const JAVA_IMPORT_RE = /^import\s+(?:static\s+)?(\S+)\s*;/gm;

function extractJavaImports(source: string): ImportRef[] {
  const imports: ImportRef[] = [];
  for (const m of source.matchAll(JAVA_IMPORT_RE)) {
    imports.push({ source: m[1]!, type: 'import' });
  }
  return imports;
}

// --- Java adapter ---

function hasJavaModifier(node: TSNode, modifier: string): boolean {
  const mods = node.namedChildren.find((c) => c.type === 'modifiers');
  return mods ? mods.text.includes(modifier) : false;
}

/** Java adapter that extracts both top-level types and their members (methods, fields) from class/interface bodies. */
export class JavaAdapter implements LanguageAdapter {
  readonly extensions = ['.java'] as const;
  readonly languageId = 'java';
  readonly wasmModule = 'tree-sitter-java/tree-sitter-java.wasm';

  extractSymbols(rootNode: TSNode): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    for (const node of rootNode.namedChildren) {
      this.extractNode(node, symbols);
    }
    return symbols;
  }

  extractImports(source: string): ImportRef[] {
    return extractJavaImports(source);
  }

  private extractNode(node: TSNode, symbols: SymbolInfo[]): void {
    if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      const exported = hasJavaModifier(node, 'public');
      symbols.push({
        name: nameNode.text,
        kind: node.type === 'interface_declaration' ? 'type' : 'class',
        exported,
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });

      // Extract members from class body
      const body = node.namedChildren.find(
        (c) => c.type === 'class_body' || c.type === 'interface_body',
      );
      if (body) {
        for (const member of body.namedChildren) {
          this.extractMember(member, symbols);
        }
      }
    }
  }

  private extractMember(node: TSNode, symbols: SymbolInfo[]): void {
    if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      const exported = hasJavaModifier(node, 'public');
      symbols.push({
        name: nameNode.text,
        kind: 'method',
        exported,
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });
    } else if (node.type === 'field_declaration') {
      const isFinal = hasJavaModifier(node, 'final');
      const exported = hasJavaModifier(node, 'public');
      const declarator = node.childForFieldName('declarator');
      if (!declarator) return;
      const nameNode = declarator.childForFieldName('name');
      if (!nameNode) return;
      symbols.push({
        name: nameNode.text,
        kind: isFinal ? 'constant' : 'variable',
        exported,
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });
    }
  }
}

// --- C# import extraction helpers ---

const CSHARP_USING_RE = /^using\s+(?:static\s+)?(\S+)\s*;/gm;

function extractCSharpImports(source: string): ImportRef[] {
  const imports: ImportRef[] = [];
  for (const m of source.matchAll(CSHARP_USING_RE)) {
    imports.push({ source: m[1]!, type: 'import' });
  }
  return imports;
}

// --- C# adapter ---

function hasCSharpModifier(node: TSNode, modifier: string): boolean {
  return node.namedChildren.some((c) => c.type === 'modifier' && c.text === modifier);
}

/** C# adapter that recursively traverses namespace declarations to extract types and their members. */
export class CSharpAdapter implements LanguageAdapter {
  readonly extensions = ['.cs'] as const;
  readonly languageId = 'csharp';
  readonly wasmModule = 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm';

  extractSymbols(rootNode: TSNode): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    for (const node of rootNode.namedChildren) {
      this.extractNode(node, symbols);
    }
    return symbols;
  }

  extractImports(source: string): ImportRef[] {
    return extractCSharpImports(source);
  }

  private extractNode(node: TSNode, symbols: SymbolInfo[]): void {
    if (
      node.type === 'class_declaration' ||
      node.type === 'struct_declaration' ||
      node.type === 'interface_declaration'
    ) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      const exported = hasCSharpModifier(node, 'public');
      const kind: SymbolKind =
        node.type === 'interface_declaration' ? 'type' : 'class';
      symbols.push({
        name: nameNode.text,
        kind,
        exported,
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });

      // Extract members from declaration_list
      const body = node.namedChildren.find((c) => c.type === 'declaration_list');
      if (body) {
        for (const member of body.namedChildren) {
          this.extractMember(member, symbols);
        }
      }
    } else if (node.type === 'namespace_declaration') {
      // Recurse into namespaces
      const body = node.namedChildren.find((c) => c.type === 'declaration_list');
      if (body) {
        for (const child of body.namedChildren) {
          this.extractNode(child, symbols);
        }
      }
    }
  }

  private extractMember(node: TSNode, symbols: SymbolInfo[]): void {
    if (node.type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      const exported = hasCSharpModifier(node, 'public');
      symbols.push({
        name: nameNode.text,
        kind: 'method',
        exported,
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });
    }
  }
}

// --- SQL adapter ---

const SQL_CREATE_RE =
  /CREATE\s+(?:OR\s+REPLACE\s+)?(?:(TABLE|FUNCTION|PROCEDURE|VIEW|INDEX|TRIGGER))\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;

/** SQL adapter (no tree-sitter grammar). `extractSymbols` returns []; use `heuristicExtract` to parse CREATE statements. */
export class SqlAdapter implements LanguageAdapter {
  readonly extensions = ['.sql'] as const;
  readonly languageId = 'sql';
  readonly wasmModule = null;

  extractSymbols(_rootNode: TSNode): SymbolInfo[] {
    // SQL uses heuristic extraction from source text
    return [];
  }

  extractImports(_source: string): ImportRef[] {
    return [];
  }

  heuristicExtract(source: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    for (const m of source.matchAll(SQL_CREATE_RE)) {
      const objType = m[1]!.toUpperCase();
      let kind: SymbolKind;
      if (objType === 'TABLE') kind = 'class';
      else if (objType === 'FUNCTION' || objType === 'PROCEDURE' || objType === 'TRIGGER')
        kind = 'function';
      else kind = 'variable'; // VIEW, INDEX
      symbols.push({
        name: m[2]!,
        kind,
        exported: true,
        line_start: 1,
        line_end: 1,
      });
    }
    return symbols;
  }
}

// --- YAML adapter ---

const YAML_TOP_LEVEL_KEY_RE = /^([a-zA-Z_][\w-]*):/gm;
const YAML_NESTED_KEY_RE = /^  ([a-zA-Z_][\w-]*):/gm;

/** YAML adapter (no tree-sitter grammar). `extractSymbols` returns []; `heuristicExtract` maps top-level keys to variables and nested keys to constants. */
export class YamlAdapter implements LanguageAdapter {
  readonly extensions = ['.yml', '.yaml'] as const;
  readonly languageId = 'yaml';
  readonly wasmModule = null;

  extractSymbols(_rootNode: TSNode): SymbolInfo[] {
    return [];
  }

  extractImports(_source: string): ImportRef[] {
    return [];
  }

  heuristicExtract(source: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    // Top-level keys → variable
    for (const m of source.matchAll(YAML_TOP_LEVEL_KEY_RE)) {
      symbols.push({
        name: m[1]!,
        kind: 'variable',
        exported: true,
        line_start: 1,
        line_end: 1,
      });
    }
    // Nested keys (2-space indent, e.g. Docker Compose service names) → constant
    for (const m of source.matchAll(YAML_NESTED_KEY_RE)) {
      symbols.push({
        name: m[1]!,
        kind: 'constant',
        exported: true,
        line_start: 1,
        line_end: 1,
      });
    }
    return symbols;
  }
}

// --- JSON adapter ---

/** JSON adapter (no tree-sitter grammar). `extractSymbols` returns []; `heuristicExtract` maps top-level object keys to variable symbols. */
export class JsonAdapter implements LanguageAdapter {
  readonly extensions = ['.json'] as const;
  readonly languageId = 'json';
  readonly wasmModule = null;

  extractSymbols(_rootNode: TSNode): SymbolInfo[] {
    return [];
  }

  extractImports(_source: string): ImportRef[] {
    return [];
  }

  heuristicExtract(source: string): SymbolInfo[] {
    try {
      const parsed: unknown = JSON.parse(source);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
      return Object.keys(parsed as Record<string, unknown>).map((key) => ({
        name: key,
        kind: 'variable' as SymbolKind,
        exported: true,
        line_start: 1,
        line_end: 1,
      }));
    } catch {
      return [];
    }
  }
}

// --- Adapter registry ---

const adapters: LanguageAdapter[] = [
  new TypeScriptAdapter(),
  new TsxAdapter(),
  new BashAdapter(),
  new PythonAdapter(),
  new RustAdapter(),
  new GoAdapter(),
  new JavaAdapter(),
  new CSharpAdapter(),
  new SqlAdapter(),
  new YamlAdapter(),
  new JsonAdapter(),
];

/** Pre-populated registry mapping dot-prefixed file extensions (e.g. `'.ts'`) to their {@link LanguageAdapter}. */
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

const MAKEFILE_TARGET_RE = /^([a-zA-Z_][\w.-]*):/gm;
const DOCKERFILE_STAGE_RE = /^FROM\s+\S+\s+AS\s+(\S+)/gim;
const UPPER_SNAKE_ASSIGN_RE = /^([A-Z][A-Z0-9_]*)=/gm;

function countSignificantLines(source: string): number {
  return source
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('#') && !t.startsWith('//') && !t.startsWith('--');
    }).length;
}

/**
 * Fallback parser for files with no registered adapter.
 * Dispatches by filename to Makefile-target, Dockerfile-stage, or generic UPPER_SNAKE constant extraction.
 * Files with fewer than 5 significant lines are skipped.
 */
export function heuristicParse(source: string, filename?: string): SymbolInfo[] {
  if (countSignificantLines(source) < 5) return [];

  const base = filename?.toLowerCase() ?? '';

  // Makefile targets
  if (base === 'makefile' || base.endsWith('.mk')) {
    const symbols: SymbolInfo[] = [];
    for (const m of source.matchAll(MAKEFILE_TARGET_RE)) {
      const name = m[1]!;
      if (name.startsWith('.')) continue; // skip .PHONY, .DEFAULT, etc.
      symbols.push({ name, kind: 'function', exported: true, line_start: 1, line_end: 1 });
    }
    return symbols;
  }

  // Dockerfile stages
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
    const symbols: SymbolInfo[] = [];
    for (const m of source.matchAll(DOCKERFILE_STAGE_RE)) {
      symbols.push({ name: m[1]!, kind: 'function', exported: true, line_start: 1, line_end: 1 });
    }
    return symbols;
  }

  // Generic: UPPER_SNAKE assignments → constants
  const symbols: SymbolInfo[] = [];
  for (const m of source.matchAll(UPPER_SNAKE_ASSIGN_RE)) {
    symbols.push({ name: m[1]!, kind: 'constant', exported: true, line_start: 1, line_end: 1 });
  }
  return symbols;
}
