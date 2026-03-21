# Scanner

The scanner (`src/core/scanner.ts`) is the first stage of the Anatoly pipeline. It walks the project tree, parses each TypeScript file into an AST using tree-sitter WASM, extracts symbol metadata, computes content hashes for change detection, and writes `.task.json` files that feed every downstream stage.

## File Collection

`collectFiles()` resolves which files enter the pipeline:

1. Glob patterns from `config.scan.include` are expanded with `tinyglobby`.
2. Patterns listed in `config.scan.exclude` are removed.
3. Files not tracked by Git (`.gitignore`'d) are filtered out via `getGitTrackedFiles()`.
4. The result is deduplicated and sorted for deterministic ordering across runs.

## Tree-sitter WASM Parsing

Anatoly uses `web-tree-sitter` with pre-compiled WASM grammars. Two language modules are loaded on demand:

| Extension | WASM module |
|-----------|-------------|
| `.ts`     | `tree-sitter-typescript/tree-sitter-typescript.wasm` |
| `.tsx`    | `tree-sitter-typescript/tree-sitter-tsx.wasm` |

Both the `Parser` instance and loaded `Language` objects are cached in module-level singletons so initialisation happens only once per process, regardless of how many files are scanned.

The parser produces a concrete syntax tree whose root node is passed to `extractSymbols()`.

## Symbol Extraction

`extractSymbols()` iterates over the top-level named children of the root AST node. It recognises two categories of declarations:

### Direct declarations

Mapped through the `DECLARATION_KINDS` table:

| AST node type                | SymbolKind |
|------------------------------|------------|
| `function_declaration`       | `function` |
| `class_declaration`          | `class`    |
| `abstract_class_declaration` | `class`    |
| `interface_declaration`      | `type`     |
| `type_alias_declaration`     | `type`     |
| `enum_declaration`           | `enum`     |
| `method_definition`          | `method`   |

### Lexical declarations (`const` / `let`)

Each `variable_declarator` inside a lexical declaration is classified by inspecting the variable name and its initialiser value:

| Condition | SymbolKind |
|-----------|------------|
| Name matches `/^use[A-Z]/` | `hook` |
| Name matches `/^[A-Z_][A-Z0-9_]*$/` | `constant` |
| Value is `arrow_function` or `function` | `function` |
| Otherwise | `variable` |

### Export detection

When a declaration is wrapped in an `export_statement` AST node, the symbol's `exported` flag is set to `true`. This flag drives downstream logic in the utility axis and triage module.

### Output per symbol

Each extracted symbol produces a `SymbolInfo` record:

```typescript
{
  name: string;
  kind: SymbolKind;      // function | class | type | enum | method | hook | constant | variable
  exported: boolean;
  line_start: number;    // 1-based
  line_end: number;      // 1-based
}
```

## SHA-256 Change Detection

For every file, `computeFileHash()` (from `src/utils/cache.ts`) produces a SHA-256 digest of the file content. During scanning, this hash is compared against the hash stored in `progress.json` from the previous run:

- If the hash matches, the file was previously `DONE` or `CACHED`, **and** all requested axes were covered by the previous evaluation, the file is marked `CACHED` and no new `.task.json` is written. This skips re-parsing entirely.
- If the hash differs, no prior entry exists, or the previous run evaluated a different set of axes, the file is treated as new: its AST is parsed, a `.task.json` is written, and its progress status is set to `PENDING`.

This mechanism ensures that incremental runs only process changed files. The per-axis tracking means that switching from `--axes utility` to `--axes correction` correctly invalidates the cache and triggers a full re-review for the newly requested axes.

## Task File Output

For each new or changed file, `scanProject()` writes a `.task.json` file to `.anatoly/tasks/`:

```typescript
{
  version: 1,
  file: string;          // relative path
  hash: string;          // SHA-256
  symbols: SymbolInfo[];
  scanned_at: string;    // ISO timestamp
  coverage?: CoverageData;
}
```

The filename is derived from the relative path via `toOutputName()`, and the write is atomic (write-to-temp then rename) to prevent corruption on crash.

## Coverage Integration

When `config.coverage.enabled` is `true`, `loadCoverage()` reads an Istanbul/Vitest/Jest `coverage-final.json` file and builds a `Map<string, CoverageData>` keyed by relative file path. Coverage data attached to each task includes:

- `statements_total` / `statements_covered`
- `branches_total` / `branches_covered`
- `functions_total` / `functions_covered`
- `lines_total` / `lines_covered`

This data is consumed by the tests axis evaluator to inform its GOOD / WEAK / NONE ratings.

## Progress Tracking

After all files are processed, `scanProject()` writes `progress.json` atomically to `.anatoly/cache/`. This file maps every relative path to its current hash and status (`PENDING` or `CACHED`), enabling the worker pool to know which files need evaluation.

## Scan Result

`scanProject()` returns a `ScanResult` summary:

```typescript
{
  filesScanned: number;  // total files matching glob
  filesCached: number;   // unchanged since last run
  filesNew: number;      // new or modified files
}
```

## Key Source Paths

- Scanner: `src/core/scanner.ts`
- Cache utilities: `src/utils/cache.ts`
- Git helpers: `src/utils/git.ts`
- Task schema: `src/schemas/task.ts`
