// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import type { Node as TSNode } from 'web-tree-sitter';
import {
  TypeScriptAdapter,
  TsxAdapter,
  BashAdapter,
  PythonAdapter,
  RustAdapter,
  resolveAdapter,
  heuristicParse,
  ADAPTER_REGISTRY,
  type LanguageAdapter,
  type ImportRef,
} from './language-adapters.js';

// --- Mock tree-sitter node builder ---
interface MockData {
  type: string;
  text: string;
  children?: MockData[];
  fields?: Record<string, MockData>;
  startRow?: number;
  endRow?: number;
}
function mockNode(d: MockData): TSNode {
  const fieldNodes: Record<string, TSNode> = {};
  if (d.fields) for (const [k, v] of Object.entries(d.fields)) fieldNodes[k] = mockNode(v);
  return {
    type: d.type,
    text: d.text,
    namedChildren: (d.children ?? []).map(mockNode),
    startPosition: { row: d.startRow ?? 0, column: 0 },
    endPosition: { row: d.endRow ?? 0, column: 0 },
    childForFieldName: (name: string) => fieldNodes[name] ?? null,
  } as unknown as TSNode;
}

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

// --- Story 31.7: BashAdapter ---

describe('BashAdapter', () => {
  const adapter = new BashAdapter();

  it('has extensions [".sh", ".bash"]', () => {
    expect(adapter.extensions).toEqual(['.sh', '.bash']);
  });

  it('has languageId "bash"', () => {
    expect(adapter.languageId).toBe('bash');
  });

  it('has wasmModule "bash"', () => {
    expect(adapter.wasmModule).toBe('bash');
  });
});

describe('BashAdapter.extractSymbols', () => {
  const adapter = new BashAdapter();

  // AC 31.7.1: function keyword form
  it('AC 31.7.1: extracts function with "function" keyword', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [{
        type: 'function_definition', text: 'function setup_gpu() { echo hi; }',
        fields: { name: { type: 'word', text: 'setup_gpu', startRow: 2, endRow: 2 } },
        startRow: 2, endRow: 4,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'setup_gpu', kind: 'function', exported: true });
  });

  // AC 31.7.2: name() form (no function keyword)
  it('AC 31.7.2: extracts function without "function" keyword', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [{
        type: 'function_definition', text: 'setup_gpu() { echo hi; }',
        fields: { name: { type: 'word', text: 'setup_gpu', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 2,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'setup_gpu', kind: 'function' });
  });

  // AC 31.7.3: UPPER_SNAKE variable → constant
  it('AC 31.7.3: extracts UPPER_SNAKE variable as constant', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [{
        type: 'variable_assignment', text: 'DOCKER_IMAGE="ghcr.io/org/repo"',
        fields: { name: { type: 'variable_name', text: 'DOCKER_IMAGE', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 0,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'DOCKER_IMAGE', kind: 'constant', exported: true });
  });

  // AC 31.7.4: lower_case variable → variable
  it('AC 31.7.4: extracts non-UPPER_SNAKE as variable', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [{
        type: 'variable_assignment', text: 'result_dir="./output"',
        fields: { name: { type: 'variable_name', text: 'result_dir', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 0,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'result_dir', kind: 'variable', exported: true });
  });

  // AC 31.7.5: underscore prefix → exported: false
  it('AC 31.7.5: marks underscore-prefixed as not exported', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [{
        type: 'function_definition', text: '_internal_helper() { true; }',
        fields: { name: { type: 'word', text: '_internal_helper', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 1,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.exported).toBe(false);
  });

  // AC 31.7.7: local variables NOT extracted
  it('AC 31.7.7: does NOT extract local variables inside functions', () => {
    // local declarations are inside function_definition → compound_statement,
    // so they are NOT direct children of program
    const root = mockNode({
      type: 'program', text: '',
      children: [{
        type: 'function_definition', text: 'my_func() { local x=1; }',
        fields: { name: { type: 'word', text: 'my_func', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 2,
        children: [{
          type: 'compound_statement', text: '{ local x=1; }',
          children: [{
            type: 'declaration_command', text: 'local x=1',
            startRow: 1, endRow: 1,
          }],
        }],
      }],
    });
    const symbols = adapter.extractSymbols(root);
    // Only the function, not 'x'
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('my_func');
  });

  // Mixed: multiple symbols
  it('extracts multiple symbols from a bash script', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [
        {
          type: 'variable_assignment', text: 'VERSION="1.0"',
          fields: { name: { type: 'variable_name', text: 'VERSION', startRow: 0, endRow: 0 } },
          startRow: 0, endRow: 0,
        },
        {
          type: 'function_definition', text: 'main() { echo; }',
          fields: { name: { type: 'word', text: 'main', startRow: 1, endRow: 1 } },
          startRow: 1, endRow: 3,
        },
        {
          type: 'variable_assignment', text: 'output_dir="./out"',
          fields: { name: { type: 'variable_name', text: 'output_dir', startRow: 4, endRow: 4 } },
          startRow: 4, endRow: 4,
        },
      ],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({ name: 'VERSION', kind: 'constant' });
    expect(symbols[1]).toMatchObject({ name: 'main', kind: 'function' });
    expect(symbols[2]).toMatchObject({ name: 'output_dir', kind: 'variable' });
  });

  // Ignores non-symbol nodes
  it('ignores non-symbol nodes like comments and commands', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [
        { type: 'comment', text: '# a comment', startRow: 0, endRow: 0 },
        { type: 'command', text: 'echo hello', startRow: 1, endRow: 1 },
      ],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toEqual([]);
  });
});

describe('BashAdapter.extractImports', () => {
  const adapter = new BashAdapter();

  // AC 31.7.6: source and . commands
  it('AC 31.7.6: extracts source and . imports', () => {
    const source = `#!/bin/bash
source ./lib/helpers.sh
. ./lib/logging.sh
echo "done"`;
    const imports = adapter.extractImports(source);
    expect(imports).toHaveLength(2);
    expect(imports[0]).toEqual({ source: './lib/helpers.sh', type: 'source' });
    expect(imports[1]).toEqual({ source: './lib/logging.sh', type: 'source' });
  });

  it('ignores lines without source/dot', () => {
    expect(adapter.extractImports('echo "hello"\nls -la')).toEqual([]);
  });

  it('handles source with quoted paths', () => {
    const imports = adapter.extractImports('source "./lib/config.sh"');
    expect(imports).toHaveLength(1);
    expect(imports[0]!.source).toBe('./lib/config.sh');
  });
});

describe('BashAdapter registry', () => {
  it('resolves .sh to BashAdapter', () => {
    expect(resolveAdapter('.sh')).toBeInstanceOf(BashAdapter);
  });

  it('resolves .bash to BashAdapter', () => {
    expect(resolveAdapter('.bash')).toBeInstanceOf(BashAdapter);
  });
});

// --- Story 31.8: PythonAdapter ---

describe('PythonAdapter', () => {
  const adapter = new PythonAdapter();

  it('has extensions [".py"]', () => {
    expect(adapter.extensions).toEqual(['.py']);
  });

  it('has languageId "python"', () => {
    expect(adapter.languageId).toBe('python');
  });

  it('has wasmModule "python"', () => {
    expect(adapter.wasmModule).toBe('python');
  });
});

describe('PythonAdapter.extractSymbols', () => {
  const adapter = new PythonAdapter();

  // AC 31.8.1: function definition
  it('AC 31.8.1: extracts function definition', () => {
    const root = mockNode({
      type: 'module', text: '',
      children: [{
        type: 'function_definition', text: 'def process_data(input: str) -> dict:\n    pass',
        fields: { name: { type: 'identifier', text: 'process_data', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 1,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'process_data', kind: 'function', exported: true });
  });

  // AC 31.8.2: class definition
  it('AC 31.8.2: extracts class definition', () => {
    const root = mockNode({
      type: 'module', text: '',
      children: [{
        type: 'class_definition', text: 'class DataPipeline:\n    pass',
        fields: { name: { type: 'identifier', text: 'DataPipeline', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 2,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'DataPipeline', kind: 'class', exported: true });
  });

  // AC 31.8.3: UPPER_SNAKE constant
  it('AC 31.8.3: extracts UPPER_SNAKE assignment as constant', () => {
    const root = mockNode({
      type: 'module', text: '',
      children: [{
        type: 'expression_statement', text: 'MAX_RETRIES = 3',
        children: [{
          type: 'assignment', text: 'MAX_RETRIES = 3',
          fields: {
            left: { type: 'identifier', text: 'MAX_RETRIES', startRow: 0, endRow: 0 },
            right: { type: 'integer', text: '3', startRow: 0, endRow: 0 },
          },
          startRow: 0, endRow: 0,
        }],
        startRow: 0, endRow: 0,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'MAX_RETRIES', kind: 'constant', exported: true });
  });

  // AC 31.8.4: non-UPPER_SNAKE variable
  it('AC 31.8.4: extracts non-UPPER_SNAKE assignment as variable', () => {
    const root = mockNode({
      type: 'module', text: '',
      children: [{
        type: 'expression_statement', text: 'config = load_config()',
        children: [{
          type: 'assignment', text: 'config = load_config()',
          fields: {
            left: { type: 'identifier', text: 'config', startRow: 0, endRow: 0 },
          },
          startRow: 0, endRow: 0,
        }],
        startRow: 0, endRow: 0,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'config', kind: 'variable', exported: true });
  });

  // AC 31.8.5: underscore prefix → not exported
  it('AC 31.8.5: marks underscore-prefixed as not exported', () => {
    const root = mockNode({
      type: 'module', text: '',
      children: [{
        type: 'function_definition', text: 'def _internal_helper():\n    pass',
        fields: { name: { type: 'identifier', text: '_internal_helper', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 1,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.exported).toBe(false);
  });

  // AC 31.8.6: __all__ overrides underscore convention
  it('AC 31.8.6: __all__ overrides export detection', () => {
    const root = mockNode({
      type: 'module', text: '',
      children: [
        // __all__ = ['public_func']
        {
          type: 'expression_statement', text: "__all__ = ['public_func']",
          children: [{
            type: 'assignment', text: "__all__ = ['public_func']",
            fields: {
              left: { type: 'identifier', text: '__all__', startRow: 0, endRow: 0 },
              right: { type: 'list', text: "['public_func']", startRow: 0, endRow: 0 },
            },
            startRow: 0, endRow: 0,
          }],
          startRow: 0, endRow: 0,
        },
        // public_func — in __all__, should be exported
        {
          type: 'function_definition', text: 'def public_func():\n    pass',
          fields: { name: { type: 'identifier', text: 'public_func', startRow: 2, endRow: 2 } },
          startRow: 2, endRow: 3,
        },
        // other_func — NOT in __all__, should NOT be exported
        {
          type: 'function_definition', text: 'def other_func():\n    pass',
          fields: { name: { type: 'identifier', text: 'other_func', startRow: 4, endRow: 4 } },
          startRow: 4, endRow: 5,
        },
      ],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(2);
    const pub = symbols.find((s) => s.name === 'public_func');
    const other = symbols.find((s) => s.name === 'other_func');
    expect(pub!.exported).toBe(true);
    expect(other!.exported).toBe(false);
  });

  // AC 31.8.7: decorated function
  it('AC 31.8.7: extracts decorated function', () => {
    const root = mockNode({
      type: 'module', text: '',
      children: [{
        type: 'decorated_definition', text: '@click.command()\ndef cli():\n    pass',
        startRow: 0, endRow: 2,
        children: [
          { type: 'decorator', text: '@click.command()', startRow: 0, endRow: 0 },
          {
            type: 'function_definition', text: 'def cli():\n    pass',
            fields: { name: { type: 'identifier', text: 'cli', startRow: 1, endRow: 1 } },
            startRow: 1, endRow: 2,
          },
        ],
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'cli', kind: 'function', exported: true });
  });

  // AC 31.8.9: nested function — only outer extracted
  it('AC 31.8.9: only extracts top-level, ignores nested functions', () => {
    const root = mockNode({
      type: 'module', text: '',
      children: [{
        type: 'function_definition', text: 'def outer():\n    def inner():\n        pass',
        fields: { name: { type: 'identifier', text: 'outer', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 2,
        children: [{
          type: 'block', text: '    def inner():\n        pass',
          children: [{
            type: 'function_definition', text: 'def inner():\n    pass',
            fields: { name: { type: 'identifier', text: 'inner', startRow: 1, endRow: 1 } },
            startRow: 1, endRow: 2,
          }],
        }],
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('outer');
  });
});

describe('PythonAdapter.extractImports', () => {
  const adapter = new PythonAdapter();

  // AC 31.8.8: import and from...import
  it('AC 31.8.8: extracts import and from...import', () => {
    const source = `from utils import helper
import os
from pathlib import Path`;
    const imports = adapter.extractImports(source);
    expect(imports).toHaveLength(3);
    expect(imports[0]).toEqual({ source: 'utils', type: 'import' });
    expect(imports[1]).toEqual({ source: 'os', type: 'import' });
    expect(imports[2]).toEqual({ source: 'pathlib', type: 'import' });
  });

  it('returns empty for no imports', () => {
    expect(adapter.extractImports('x = 1\nprint(x)')).toEqual([]);
  });
});

describe('PythonAdapter registry', () => {
  it('resolves .py to PythonAdapter', () => {
    expect(resolveAdapter('.py')).toBeInstanceOf(PythonAdapter);
  });
});

// --- Story 31.9: RustAdapter ---

describe('RustAdapter', () => {
  const adapter = new RustAdapter();

  it('has extensions [".rs"]', () => {
    expect(adapter.extensions).toEqual(['.rs']);
  });

  it('has languageId "rust"', () => {
    expect(adapter.languageId).toBe('rust');
  });

  it('has wasmModule "rust"', () => {
    expect(adapter.wasmModule).toBe('rust');
  });
});

describe('RustAdapter.extractSymbols', () => {
  const adapter = new RustAdapter();

  // AC 31.9.1: pub fn → exported function
  it('AC 31.9.1: extracts pub fn as exported function', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'function_item', text: 'pub fn parse(input: &str) -> Result<AST, Error> { }',
        fields: { name: { type: 'identifier', text: 'parse', startRow: 0, endRow: 0 } },
        children: [{ type: 'visibility_modifier', text: 'pub', startRow: 0, endRow: 0 }],
        startRow: 0, endRow: 2,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'parse', kind: 'function', exported: true });
  });

  // AC 31.9.2: fn without pub → not exported
  it('AC 31.9.2: extracts fn without pub as not exported', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'function_item', text: 'fn internal_helper() { }',
        fields: { name: { type: 'identifier', text: 'internal_helper', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 1,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'internal_helper', kind: 'function', exported: false });
  });

  // AC 31.9.3: pub struct → class, exported
  it('AC 31.9.3: extracts pub struct as class', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'struct_item', text: 'pub struct Config { field: String }',
        fields: { name: { type: 'type_identifier', text: 'Config', startRow: 0, endRow: 0 } },
        children: [{ type: 'visibility_modifier', text: 'pub', startRow: 0, endRow: 0 }],
        startRow: 0, endRow: 2,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'Config', kind: 'class', exported: true });
  });

  // AC 31.9.4: pub trait → type, exported
  it('AC 31.9.4: extracts pub trait as type', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'trait_item', text: 'pub trait Parser { fn parse(&self); }',
        fields: { name: { type: 'type_identifier', text: 'Parser', startRow: 0, endRow: 0 } },
        children: [{ type: 'visibility_modifier', text: 'pub', startRow: 0, endRow: 0 }],
        startRow: 0, endRow: 3,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'Parser', kind: 'type', exported: true });
  });

  // AC 31.9.5: pub enum → enum, exported
  it('AC 31.9.5: extracts pub enum as enum', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'enum_item', text: 'pub enum Color { Red, Green, Blue }',
        fields: { name: { type: 'type_identifier', text: 'Color', startRow: 0, endRow: 0 } },
        children: [{ type: 'visibility_modifier', text: 'pub', startRow: 0, endRow: 0 }],
        startRow: 0, endRow: 0,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'Color', kind: 'enum', exported: true });
  });

  // AC 31.9.6: pub const → constant
  it('AC 31.9.6: extracts pub const as constant', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'const_item', text: 'pub const MAX_SIZE: usize = 1024;',
        fields: { name: { type: 'identifier', text: 'MAX_SIZE', startRow: 0, endRow: 0 } },
        children: [{ type: 'visibility_modifier', text: 'pub', startRow: 0, endRow: 0 }],
        startRow: 0, endRow: 0,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'MAX_SIZE', kind: 'constant', exported: true });
  });

  // static item → constant
  it('extracts static item as constant', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'static_item', text: 'static COUNTER: AtomicUsize = AtomicUsize::new(0);',
        fields: { name: { type: 'identifier', text: 'COUNTER', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 0,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'COUNTER', kind: 'constant', exported: false });
  });

  // Mixed symbols
  it('extracts multiple symbols from a Rust file', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [
        {
          type: 'function_item', text: 'pub fn main() {}',
          fields: { name: { type: 'identifier', text: 'main', startRow: 0, endRow: 0 } },
          children: [{ type: 'visibility_modifier', text: 'pub', startRow: 0, endRow: 0 }],
          startRow: 0, endRow: 1,
        },
        {
          type: 'struct_item', text: 'struct Internal {}',
          fields: { name: { type: 'type_identifier', text: 'Internal', startRow: 2, endRow: 2 } },
          startRow: 2, endRow: 2,
        },
        {
          type: 'const_item', text: 'const VERSION: &str = "1.0";',
          fields: { name: { type: 'identifier', text: 'VERSION', startRow: 3, endRow: 3 } },
          startRow: 3, endRow: 3,
        },
      ],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({ name: 'main', kind: 'function', exported: true });
    expect(symbols[1]).toMatchObject({ name: 'Internal', kind: 'class', exported: false });
    expect(symbols[2]).toMatchObject({ name: 'VERSION', kind: 'constant', exported: false });
  });

  // Ignores non-symbol nodes
  it('ignores non-symbol nodes like use_declaration and comments', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [
        { type: 'use_declaration', text: 'use std::io;', startRow: 0, endRow: 0 },
        { type: 'line_comment', text: '// a comment', startRow: 1, endRow: 1 },
      ],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toEqual([]);
  });
});

describe('RustAdapter.extractImports', () => {
  const adapter = new RustAdapter();

  // AC 31.9.7: use statement
  it('AC 31.9.7: extracts use declarations', () => {
    const source = `use crate::utils::helper;
use std::collections::HashMap;
use serde::Serialize;`;
    const imports = adapter.extractImports(source);
    expect(imports).toHaveLength(3);
    expect(imports[0]).toEqual({ source: 'crate::utils::helper', type: 'import' });
    expect(imports[1]).toEqual({ source: 'std::collections::HashMap', type: 'import' });
    expect(imports[2]).toEqual({ source: 'serde::Serialize', type: 'import' });
  });

  it('returns empty for no imports', () => {
    expect(adapter.extractImports('fn main() { println!("hello"); }')).toEqual([]);
  });
});

describe('RustAdapter registry', () => {
  it('resolves .rs to RustAdapter', () => {
    expect(resolveAdapter('.rs')).toBeInstanceOf(RustAdapter);
  });
});
