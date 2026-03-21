// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  TypeScriptAdapter,
  TsxAdapter,
  resolveAdapter,
  heuristicParse,
  ADAPTER_REGISTRY,
  type LanguageAdapter,
  type ImportRef,
} from './language-adapters.js';

describe('LanguageAdapter interface', () => {
  // --- AC 31.6.1: Interface defines required properties ---
  it('AC 31.6.1: TypeScriptAdapter defines extensions, languageId, wasmModule, extractSymbols, extractImports', () => {
    const adapter: LanguageAdapter = new TypeScriptAdapter();
    expect(adapter.extensions).toBeDefined();
    expect(adapter.languageId).toBe('typescript');
    expect(adapter.wasmModule).toBe('tree-sitter-typescript/tree-sitter-typescript.wasm');
    expect(typeof adapter.extractSymbols).toBe('function');
    expect(typeof adapter.extractImports).toBe('function');
  });
});

describe('TypeScriptAdapter', () => {
  const adapter = new TypeScriptAdapter();

  it('AC 31.6.2: has extensions [".ts"]', () => {
    expect(adapter.extensions).toEqual(['.ts']);
  });

  it('has languageId "typescript"', () => {
    expect(adapter.languageId).toBe('typescript');
  });

  it('has correct wasmModule', () => {
    expect(adapter.wasmModule).toBe('tree-sitter-typescript/tree-sitter-typescript.wasm');
  });
});

describe('TsxAdapter', () => {
  const adapter = new TsxAdapter();

  it('AC 31.6.2: has extensions [".tsx"]', () => {
    expect(adapter.extensions).toEqual(['.tsx']);
  });

  it('has languageId "tsx"', () => {
    expect(adapter.languageId).toBe('tsx');
  });

  it('has correct wasmModule', () => {
    expect(adapter.wasmModule).toBe('tree-sitter-typescript/tree-sitter-tsx.wasm');
  });
});

describe('resolveAdapter', () => {
  // --- AC 31.6.4: Resolves adapter from registry ---
  it('AC 31.6.4: resolves .ts to TypeScriptAdapter', () => {
    const adapter = resolveAdapter('.ts');
    expect(adapter).toBeInstanceOf(TypeScriptAdapter);
  });

  it('AC 31.6.4: resolves .tsx to TsxAdapter', () => {
    const adapter = resolveAdapter('.tsx');
    expect(adapter).toBeInstanceOf(TsxAdapter);
  });

  // --- AC 31.6.5: Unknown extension returns null ---
  it('AC 31.6.5: returns null for unknown extension', () => {
    expect(resolveAdapter('.unknown')).toBeNull();
    expect(resolveAdapter('.xyz')).toBeNull();
  });
});

describe('ADAPTER_REGISTRY', () => {
  it('maps .ts and .tsx to adapters', () => {
    expect(ADAPTER_REGISTRY.has('.ts')).toBe(true);
    expect(ADAPTER_REGISTRY.has('.tsx')).toBe(true);
  });
});

describe('heuristicParse', () => {
  // --- AC 31.6.5: Fallback for unknown extensions ---
  it('AC 31.6.5: returns empty symbols array', () => {
    const result = heuristicParse('const x = 1;');
    expect(result).toEqual([]);
  });
});

describe('extractImports', () => {
  const adapter = new TypeScriptAdapter();

  it('extracts ES import sources', () => {
    const source = `import { foo } from './foo';
import bar from '../bar';
import * as baz from 'baz';`;
    const imports = adapter.extractImports(source);
    expect(imports).toHaveLength(3);
    expect(imports.map((i: ImportRef) => i.source)).toEqual(['./foo', '../bar', 'baz']);
    expect(imports.every((i: ImportRef) => i.type === 'import')).toBe(true);
  });

  it('extracts require calls', () => {
    const source = `const a = require('./a');
const b = require("b");`;
    const imports = adapter.extractImports(source);
    expect(imports).toHaveLength(2);
    expect(imports[0]!.source).toBe('./a');
    expect(imports[0]!.type).toBe('require');
  });

  it('returns empty array for no imports', () => {
    expect(adapter.extractImports('const x = 1;')).toEqual([]);
  });
});
