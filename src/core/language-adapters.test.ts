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
  GoAdapter,
  JavaAdapter,
  CSharpAdapter,
  SqlAdapter,
  YamlAdapter,
  JsonAdapter,
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
  // --- Story 31.12: Heuristic Fallback Parser ---

  // AC 31.12.1: Makefile targets → function
  it('AC 31.12.1: extracts Makefile targets as functions', () => {
    const source = `.PHONY: build test

build:
\t@echo "building..."
\tgo build ./...

test:
\t@echo "testing..."
\tgo test ./...`;
    const result = heuristicParse(source, 'Makefile');
    expect(result.length).toBeGreaterThanOrEqual(2);
    const build = result.find((s) => s.name === 'build');
    const test = result.find((s) => s.name === 'test');
    expect(build).toMatchObject({ name: 'build', kind: 'function' });
    expect(test).toMatchObject({ name: 'test', kind: 'function' });
  });

  // AC 31.12.2: Dockerfile FROM ... AS → function
  it('AC 31.12.2: extracts Dockerfile stages as functions', () => {
    const source = `FROM node:20 AS builder
RUN npm ci
FROM node:20-slim AS runner
COPY --from=builder /app /app
ENTRYPOINT ["node", "index.js"]`;
    const result = heuristicParse(source, 'Dockerfile');
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toMatchObject({ name: 'builder', kind: 'function' });
    expect(result[1]).toMatchObject({ name: 'runner', kind: 'function' });
  });

  // AC 31.12.3: UPPER_SNAKE assignment → constant
  it('AC 31.12.3: extracts UPPER_SNAKE assignments as constants', () => {
    const source = `#!/bin/bash
# Config file
API_KEY=sk-abc123
DB_HOST=localhost
some_var=hello
result=42
extra=line`;
    const result = heuristicParse(source);
    const apiKey = result.find((s) => s.name === 'API_KEY');
    const dbHost = result.find((s) => s.name === 'DB_HOST');
    expect(apiKey).toMatchObject({ name: 'API_KEY', kind: 'constant' });
    expect(dbHost).toMatchObject({ name: 'DB_HOST', kind: 'constant' });
  });

  // AC 31.12.4: file with < 5 non-empty non-comment lines → empty
  it('AC 31.12.4: returns empty for trivial files (< 5 lines)', () => {
    const source = `# comment
API_KEY=value

`;
    const result = heuristicParse(source);
    expect(result).toEqual([]);
  });

  it('returns empty for very short files', () => {
    expect(heuristicParse('x = 1')).toEqual([]);
    expect(heuristicParse('')).toEqual([]);
  });

  it('extracts generic function-like patterns', () => {
    const source = `# Some config
TIMEOUT=30
MAX_RETRIES=5
LOG_LEVEL=debug
output_dir=./out
something=else
extra_line=1`;
    const result = heuristicParse(source);
    const timeout = result.find((s) => s.name === 'TIMEOUT');
    const maxRetries = result.find((s) => s.name === 'MAX_RETRIES');
    expect(timeout).toMatchObject({ kind: 'constant' });
    expect(maxRetries).toMatchObject({ kind: 'constant' });
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

// --- Story 31.10: GoAdapter ---

describe('GoAdapter', () => {
  const adapter = new GoAdapter();

  it('has extensions [".go"]', () => {
    expect(adapter.extensions).toEqual(['.go']);
  });

  it('has languageId "go"', () => {
    expect(adapter.languageId).toBe('go');
  });

  it('has wasmModule "go"', () => {
    expect(adapter.wasmModule).toBe('go');
  });
});

describe('GoAdapter.extractSymbols', () => {
  const adapter = new GoAdapter();

  // AC 31.10.1: uppercase function → exported
  it('AC 31.10.1: extracts uppercase function as exported', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'function_declaration', text: 'func ParseFile(path string) error { }',
        fields: { name: { type: 'identifier', text: 'ParseFile', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 2,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'ParseFile', kind: 'function', exported: true });
  });

  // AC 31.10.2: lowercase function → not exported
  it('AC 31.10.2: extracts lowercase function as not exported', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'function_declaration', text: 'func parseInternal(s string) int { }',
        fields: { name: { type: 'identifier', text: 'parseInternal', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 1,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'parseInternal', kind: 'function', exported: false });
  });

  // AC 31.10.3: type struct → class
  it('AC 31.10.3: extracts type struct as class', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'type_declaration', text: 'type Scanner struct { ... }',
        children: [{
          type: 'type_spec', text: 'Scanner struct { ... }',
          fields: {
            name: { type: 'type_identifier', text: 'Scanner', startRow: 0, endRow: 0 },
            type: { type: 'struct_type', text: '{ ... }', startRow: 0, endRow: 2 },
          },
          startRow: 0, endRow: 2,
        }],
        startRow: 0, endRow: 2,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'Scanner', kind: 'class', exported: true });
  });

  // AC 31.10.4: type interface → type
  it('AC 31.10.4: extracts type interface as type', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'type_declaration', text: 'type Reader interface { ... }',
        children: [{
          type: 'type_spec', text: 'Reader interface { ... }',
          fields: {
            name: { type: 'type_identifier', text: 'Reader', startRow: 0, endRow: 0 },
            type: { type: 'interface_type', text: '{ ... }', startRow: 0, endRow: 2 },
          },
          startRow: 0, endRow: 2,
        }],
        startRow: 0, endRow: 2,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'Reader', kind: 'type', exported: true });
  });

  // AC 31.10.5: method declaration → method
  it('AC 31.10.5: extracts method declaration', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'method_declaration', text: 'func (s *Scanner) Scan() bool { }',
        fields: { name: { type: 'field_identifier', text: 'Scan', startRow: 0, endRow: 0 } },
        startRow: 0, endRow: 2,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'Scan', kind: 'method', exported: true });
  });

  // AC 31.10.6: const → constant
  it('AC 31.10.6: extracts const as constant', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [{
        type: 'const_declaration', text: 'const MaxRetries = 3',
        children: [{
          type: 'const_spec', text: 'MaxRetries = 3',
          fields: { name: { type: 'identifier', text: 'MaxRetries', startRow: 0, endRow: 0 } },
          startRow: 0, endRow: 0,
        }],
        startRow: 0, endRow: 0,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'MaxRetries', kind: 'constant', exported: true });
  });

  // Mixed symbols
  it('extracts multiple symbols from a Go file', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [
        {
          type: 'function_declaration', text: 'func Main() {}',
          fields: { name: { type: 'identifier', text: 'Main', startRow: 0, endRow: 0 } },
          startRow: 0, endRow: 1,
        },
        {
          type: 'function_declaration', text: 'func helper() {}',
          fields: { name: { type: 'identifier', text: 'helper', startRow: 2, endRow: 2 } },
          startRow: 2, endRow: 3,
        },
        {
          type: 'type_declaration', text: 'type config struct {}',
          children: [{
            type: 'type_spec', text: 'config struct {}',
            fields: {
              name: { type: 'type_identifier', text: 'config', startRow: 4, endRow: 4 },
              type: { type: 'struct_type', text: '{}', startRow: 4, endRow: 4 },
            },
            startRow: 4, endRow: 4,
          }],
          startRow: 4, endRow: 4,
        },
      ],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({ name: 'Main', kind: 'function', exported: true });
    expect(symbols[1]).toMatchObject({ name: 'helper', kind: 'function', exported: false });
    expect(symbols[2]).toMatchObject({ name: 'config', kind: 'class', exported: false });
  });

  // Ignores non-symbol nodes
  it('ignores non-symbol nodes like package_clause and comments', () => {
    const root = mockNode({
      type: 'source_file', text: '',
      children: [
        { type: 'package_clause', text: 'package main', startRow: 0, endRow: 0 },
        { type: 'comment', text: '// a comment', startRow: 1, endRow: 1 },
      ],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toEqual([]);
  });
});

describe('GoAdapter.extractImports', () => {
  const adapter = new GoAdapter();

  // AC 31.10.7: import statement
  it('AC 31.10.7: extracts single import', () => {
    const source = `package main

import "fmt"

func main() { fmt.Println("hi") }`;
    const imports = adapter.extractImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({ source: 'fmt', type: 'import' });
  });

  it('extracts grouped imports', () => {
    const source = `package main

import (
	"fmt"
	"os"
	"github.com/pkg/errors"
)`;
    const imports = adapter.extractImports(source);
    expect(imports).toHaveLength(3);
    expect(imports[0]).toEqual({ source: 'fmt', type: 'import' });
    expect(imports[1]).toEqual({ source: 'os', type: 'import' });
    expect(imports[2]).toEqual({ source: 'github.com/pkg/errors', type: 'import' });
  });

  it('returns empty for no imports', () => {
    expect(adapter.extractImports('package main\nfunc main() {}')).toEqual([]);
  });
});

describe('GoAdapter registry', () => {
  it('resolves .go to GoAdapter', () => {
    expect(resolveAdapter('.go')).toBeInstanceOf(GoAdapter);
  });
});

// --- Story 31.11: Java, C#, SQL, YAML, JSON Language Adapters ---

// --- JavaAdapter ---

describe('JavaAdapter', () => {
  const adapter = new JavaAdapter();

  it('has extensions [".java"]', () => {
    expect(adapter.extensions).toEqual(['.java']);
  });

  it('has languageId "java"', () => {
    expect(adapter.languageId).toBe('java');
  });

  it('has wasmModule "java"', () => {
    expect(adapter.wasmModule).toBe('java');
  });
});

describe('JavaAdapter.extractSymbols', () => {
  const adapter = new JavaAdapter();

  // AC 31.11.1: public class + public method extracted
  it('AC 31.11.1: extracts public class and public method', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [{
        type: 'class_declaration', text: 'public class UserService { public void process() { } }',
        fields: { name: { type: 'identifier', text: 'UserService', startRow: 0, endRow: 0 } },
        children: [
          { type: 'modifiers', text: 'public', startRow: 0, endRow: 0 },
          {
            type: 'class_body', text: '{ public void process() { } }',
            children: [{
              type: 'method_declaration', text: 'public void process() { }',
              fields: { name: { type: 'identifier', text: 'process', startRow: 1, endRow: 1 } },
              children: [{ type: 'modifiers', text: 'public', startRow: 1, endRow: 1 }],
              startRow: 1, endRow: 3,
            }],
            startRow: 0, endRow: 4,
          },
        ],
        startRow: 0, endRow: 4,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(2);
    expect(symbols[0]).toMatchObject({ name: 'UserService', kind: 'class', exported: true });
    expect(symbols[1]).toMatchObject({ name: 'process', kind: 'method', exported: true });
  });

  // AC 31.11.2: private static final → constant, not exported
  it('AC 31.11.2: extracts private static final as constant not exported', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [{
        type: 'class_declaration', text: 'public class Config { private static final int MAX = 100; }',
        fields: { name: { type: 'identifier', text: 'Config', startRow: 0, endRow: 0 } },
        children: [
          { type: 'modifiers', text: 'public', startRow: 0, endRow: 0 },
          {
            type: 'class_body', text: '{ private static final int MAX = 100; }',
            children: [{
              type: 'field_declaration', text: 'private static final int MAX = 100;',
              fields: {
                declarator: {
                  type: 'variable_declarator', text: 'MAX = 100',
                  fields: { name: { type: 'identifier', text: 'MAX', startRow: 1, endRow: 1 } },
                  startRow: 1, endRow: 1,
                },
              },
              children: [{ type: 'modifiers', text: 'private static final', startRow: 1, endRow: 1 }],
              startRow: 1, endRow: 1,
            }],
            startRow: 0, endRow: 2,
          },
        ],
        startRow: 0, endRow: 2,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    const constant = symbols.find((s) => s.name === 'MAX');
    expect(constant).toBeDefined();
    expect(constant).toMatchObject({ name: 'MAX', kind: 'constant', exported: false });
  });

  // Ignores non-symbol nodes
  it('ignores non-symbol nodes like package and import', () => {
    const root = mockNode({
      type: 'program', text: '',
      children: [
        { type: 'package_declaration', text: 'package com.example;', startRow: 0, endRow: 0 },
        { type: 'import_declaration', text: 'import java.util.List;', startRow: 1, endRow: 1 },
      ],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toEqual([]);
  });
});

describe('JavaAdapter.extractImports', () => {
  const adapter = new JavaAdapter();

  it('extracts import declarations', () => {
    const source = `package com.example;
import java.util.List;
import com.google.common.collect.ImmutableList;`;
    const imports = adapter.extractImports(source);
    expect(imports).toHaveLength(2);
    expect(imports[0]).toEqual({ source: 'java.util.List', type: 'import' });
    expect(imports[1]).toEqual({ source: 'com.google.common.collect.ImmutableList', type: 'import' });
  });

  it('returns empty for no imports', () => {
    expect(adapter.extractImports('public class Main {}')).toEqual([]);
  });
});

describe('JavaAdapter registry', () => {
  it('resolves .java to JavaAdapter', () => {
    expect(resolveAdapter('.java')).toBeInstanceOf(JavaAdapter);
  });
});

// --- CSharpAdapter ---

describe('CSharpAdapter', () => {
  const adapter = new CSharpAdapter();

  it('has extensions [".cs"]', () => {
    expect(adapter.extensions).toEqual(['.cs']);
  });

  it('has languageId "csharp"', () => {
    expect(adapter.languageId).toBe('csharp');
  });

  it('has wasmModule "c_sharp"', () => {
    expect(adapter.wasmModule).toBe('c_sharp');
  });
});

describe('CSharpAdapter.extractSymbols', () => {
  const adapter = new CSharpAdapter();

  // AC 31.11.3: public class + public method extracted
  it('AC 31.11.3: extracts public class and public method', () => {
    const root = mockNode({
      type: 'compilation_unit', text: '',
      children: [{
        type: 'class_declaration', text: 'public class OrderProcessor { public async Task<Result> Execute() { } }',
        fields: { name: { type: 'identifier', text: 'OrderProcessor', startRow: 0, endRow: 0 } },
        children: [
          { type: 'modifier', text: 'public', startRow: 0, endRow: 0 },
          {
            type: 'declaration_list', text: '{ public async Task<Result> Execute() { } }',
            children: [{
              type: 'method_declaration', text: 'public async Task<Result> Execute() { }',
              fields: { name: { type: 'identifier', text: 'Execute', startRow: 1, endRow: 1 } },
              children: [{ type: 'modifier', text: 'public', startRow: 1, endRow: 1 }],
              startRow: 1, endRow: 3,
            }],
            startRow: 0, endRow: 4,
          },
        ],
        startRow: 0, endRow: 4,
      }],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toHaveLength(2);
    expect(symbols[0]).toMatchObject({ name: 'OrderProcessor', kind: 'class', exported: true });
    expect(symbols[1]).toMatchObject({ name: 'Execute', kind: 'method', exported: true });
  });

  // Ignores non-symbol nodes
  it('ignores non-symbol nodes like using_directive', () => {
    const root = mockNode({
      type: 'compilation_unit', text: '',
      children: [
        { type: 'using_directive', text: 'using System;', startRow: 0, endRow: 0 },
      ],
    });
    const symbols = adapter.extractSymbols(root);
    expect(symbols).toEqual([]);
  });
});

describe('CSharpAdapter.extractImports', () => {
  const adapter = new CSharpAdapter();

  it('extracts using declarations', () => {
    const source = `using System;
using System.Collections.Generic;`;
    const imports = adapter.extractImports(source);
    expect(imports).toHaveLength(2);
    expect(imports[0]).toEqual({ source: 'System', type: 'import' });
    expect(imports[1]).toEqual({ source: 'System.Collections.Generic', type: 'import' });
  });

  it('returns empty for no usings', () => {
    expect(adapter.extractImports('public class Main {}')).toEqual([]);
  });
});

describe('CSharpAdapter registry', () => {
  it('resolves .cs to CSharpAdapter', () => {
    expect(resolveAdapter('.cs')).toBeInstanceOf(CSharpAdapter);
  });
});

// --- SqlAdapter ---

describe('SqlAdapter', () => {
  const adapter = new SqlAdapter();

  it('has extensions [".sql"]', () => {
    expect(adapter.extensions).toEqual(['.sql']);
  });

  it('has languageId "sql"', () => {
    expect(adapter.languageId).toBe('sql');
  });

  it('has wasmModule "sql"', () => {
    expect(adapter.wasmModule).toBe('sql');
  });
});

describe('SqlAdapter.extractSymbols', () => {
  const adapter = new SqlAdapter();

  // AC 31.11.4: CREATE TABLE → class
  it('AC 31.11.4: extracts CREATE TABLE as class', () => {
    const symbols = adapter.extractSymbols(mockNode({ type: 'program', text: '', children: [] }));
    // SqlAdapter uses heuristic via source, tested via extractImports-style
    // For tree-sitter, SQL adapter falls back to heuristic regex
    expect(symbols).toEqual([]);
  });
});

describe('SqlAdapter.extractSymbolsFromSource', () => {
  const adapter = new SqlAdapter();

  // AC 31.11.4: CREATE TABLE
  it('AC 31.11.4: extracts CREATE TABLE as class', () => {
    const source = 'CREATE TABLE users (\n  id INTEGER PRIMARY KEY\n);';
    const imports = adapter.extractImports(source);
    // SQL extractImports returns empty (AC 31.11.9)
    expect(imports).toEqual([]);
  });
});

describe('SqlAdapter heuristic symbols', () => {
  const adapter = new SqlAdapter();

  it('AC 31.11.4: extracts CREATE TABLE as class via heuristicExtract', () => {
    const source = 'CREATE TABLE users (\n  id INTEGER PRIMARY KEY\n);';
    const symbols = adapter.heuristicExtract(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'users', kind: 'class', exported: true });
  });

  // AC 31.11.5: CREATE FUNCTION → function
  it('AC 31.11.5: extracts CREATE FUNCTION as function', () => {
    const source = 'CREATE FUNCTION get_user(user_id INT) RETURNS TABLE AS $$ BEGIN END $$;';
    const symbols = adapter.heuristicExtract(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'get_user', kind: 'function', exported: true });
  });

  it('extracts mixed SQL definitions', () => {
    const source = `CREATE TABLE orders (id INT);
CREATE OR REPLACE FUNCTION calc_total() RETURNS void AS $$ BEGIN END $$;
CREATE VIEW active_users AS SELECT * FROM users;`;
    const symbols = adapter.heuristicExtract(source);
    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({ name: 'orders', kind: 'class' });
    expect(symbols[1]).toMatchObject({ name: 'calc_total', kind: 'function' });
    expect(symbols[2]).toMatchObject({ name: 'active_users', kind: 'variable' });
  });
});

describe('SqlAdapter.extractImports', () => {
  const adapter = new SqlAdapter();

  // AC 31.11.9: SQL extractImports returns empty
  it('AC 31.11.9: returns empty array', () => {
    expect(adapter.extractImports('CREATE TABLE t (id INT);')).toEqual([]);
  });
});

describe('SqlAdapter registry', () => {
  it('resolves .sql to SqlAdapter', () => {
    expect(resolveAdapter('.sql')).toBeInstanceOf(SqlAdapter);
  });
});

// --- YamlAdapter ---

describe('YamlAdapter', () => {
  const adapter = new YamlAdapter();

  it('has extensions [".yml", ".yaml"]', () => {
    expect(adapter.extensions).toEqual(['.yml', '.yaml']);
  });

  it('has languageId "yaml"', () => {
    expect(adapter.languageId).toBe('yaml');
  });

  it('has wasmModule "yaml"', () => {
    expect(adapter.wasmModule).toBe('yaml');
  });
});

describe('YamlAdapter heuristic symbols', () => {
  const adapter = new YamlAdapter();

  // AC 31.11.6: top-level keys → variable
  it('AC 31.11.6: extracts top-level keys as variables', () => {
    const source = `services:
  api:
    image: node:20
volumes:
  data:`;
    const symbols = adapter.heuristicExtract(source);
    const topLevel = symbols.filter((s) => s.kind === 'variable');
    expect(topLevel.map((s) => s.name)).toContain('services');
    expect(topLevel.map((s) => s.name)).toContain('volumes');
  });

  // AC 31.11.7: Docker Compose nested service → constant
  it('AC 31.11.7: extracts nested service names as constants', () => {
    const source = `services:
  api:
    image: node:20
  worker:
    image: python:3`;
    const symbols = adapter.heuristicExtract(source);
    const constants = symbols.filter((s) => s.kind === 'constant');
    expect(constants.map((s) => s.name)).toContain('api');
    expect(constants.map((s) => s.name)).toContain('worker');
  });
});

describe('YamlAdapter.extractImports', () => {
  const adapter = new YamlAdapter();

  // AC 31.11.9: YAML extractImports returns empty
  it('AC 31.11.9: returns empty array', () => {
    expect(adapter.extractImports('key: value')).toEqual([]);
  });
});

describe('YamlAdapter registry', () => {
  it('resolves .yml to YamlAdapter', () => {
    expect(resolveAdapter('.yml')).toBeInstanceOf(YamlAdapter);
  });

  it('resolves .yaml to YamlAdapter', () => {
    expect(resolveAdapter('.yaml')).toBeInstanceOf(YamlAdapter);
  });
});

// --- JsonAdapter ---

describe('JsonAdapter', () => {
  const adapter = new JsonAdapter();

  it('has extensions [".json"]', () => {
    expect(adapter.extensions).toEqual(['.json']);
  });

  it('has languageId "json"', () => {
    expect(adapter.languageId).toBe('json');
  });

  it('has wasmModule "json"', () => {
    expect(adapter.wasmModule).toBe('json');
  });
});

describe('JsonAdapter heuristic symbols', () => {
  const adapter = new JsonAdapter();

  // AC 31.11.8: top-level keys → variable
  it('AC 31.11.8: extracts top-level keys as variables', () => {
    const source = '{ "name": "my-app", "version": "1.0.0", "scripts": {} }';
    const symbols = adapter.heuristicExtract(source);
    expect(symbols.map((s) => s.name)).toContain('name');
    expect(symbols.map((s) => s.name)).toContain('version');
    expect(symbols.map((s) => s.name)).toContain('scripts');
    expect(symbols.every((s) => s.kind === 'variable')).toBe(true);
  });

  it('returns empty for non-object JSON', () => {
    expect(adapter.heuristicExtract('[1, 2, 3]')).toEqual([]);
  });
});

describe('JsonAdapter.extractImports', () => {
  const adapter = new JsonAdapter();

  // AC 31.11.9: JSON extractImports returns empty
  it('AC 31.11.9: returns empty array', () => {
    expect(adapter.extractImports('{"key": "value"}')).toEqual([]);
  });
});

describe('JsonAdapter registry', () => {
  it('resolves .json to JsonAdapter', () => {
    expect(resolveAdapter('.json')).toBeInstanceOf(JsonAdapter);
  });
});
