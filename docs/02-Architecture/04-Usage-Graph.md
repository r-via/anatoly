# Usage Graph

The usage graph is a pre-computed import resolution index that maps every exported symbol to the files that consume it. Built in a single local pass with zero API calls, it provides ground-truth data that eliminates the need for the LLM to guess whether a symbol is used.

## Problem

Without import analysis, the utility axis evaluator would need to reason about whether an exported function is used anywhere in the project -- a question the LLM cannot reliably answer from a single file's source code. Asking the LLM to use tools (Grep, Glob) to search for importers would require multiple tool-use turns per symbol, multiplied across every symbol in every file. For a project with 200 files and 1000 exported symbols, this could mean thousands of redundant API calls.

## Solution

Anatoly builds the usage graph once during the setup phase (Phase 4) by scanning all project files with regex-based import extraction. The graph is then injected into every utility axis prompt as structured data, turning an open-ended search problem into a simple verification task.

**Estimated API call reduction:** approximately 90% of the tool-use calls that would otherwise be needed for utility analysis are eliminated.

## Graph Structure

The `UsageGraph` type contains two maps:

```typescript
interface UsageGraph {
  /** "symbolName::filePath" -> Set<files that runtime-import this symbol> */
  usages: Map<string, Set<string>>;

  /** "symbolName::filePath" -> Set<files that type-only import this symbol> */
  typeOnlyUsages: Map<string, Set<string>>;
}
```

The key format `"symbolName::filePath"` uniquely identifies a symbol by both its name and the file that defines it, handling the case where multiple files export symbols with the same name.

The distinction between runtime imports and type-only imports is significant: a symbol that is only type-imported may still be considered `DEAD` for runtime purposes (depending on the analysis context), while a runtime-imported symbol is definitively `USED`.

## Import Patterns Recognized

The extractor handles the following TypeScript/JavaScript import forms:

| Pattern | Example | Type |
|---------|---------|------|
| Named import | `import { A, B as C } from './path'` | Runtime |
| Default import | `import X from './path'` | Runtime |
| Namespace import | `import * as X from './path'` | Runtime (all exports) |
| Named re-export | `export { A, B } from './path'` | Runtime |
| Star re-export | `export * from './path'` | Runtime (all exports) |
| Type named import | `import type { A } from './path'` | Type-only |
| Type re-export | `export type { A } from './path'` | Type-only |

## Import Resolution

Relative import specifiers are resolved to project-relative file paths:

1. Resolve the specifier relative to the importing file's directory
2. Strip `.js` extensions (common in ESM-style TypeScript projects)
3. Try direct `.ts` / `.tsx` extensions
4. Try `/index.ts` / `/index.tsx` for directory imports

Bare specifiers (e.g., `import express from 'express'`) are skipped -- they refer to `node_modules` packages, not project files.

## How It Is Used

During the utility axis evaluation, the usage graph data is formatted into the prompt as a "Pre-computed Import Analysis" section:

```
## Pre-computed Import Analysis

- formatDuration (exported): runtime-imported by 2 files: src/commands/run.ts, src/core/reporter.ts
- buildFunctionId (exported): runtime-imported by 3 files: src/rag/orchestrator.ts, ...
- helperInternal (not exported): internal only -- check local usage in file
- MyType (exported): type-only imported by 1 file: src/schemas/config.ts -- USED (type-only)
- legacyUtil (exported): imported by 0 files -- LIKELY DEAD
```

This gives the LLM definitive evidence to classify each symbol:

- **Exported + runtime importers > 0:** definitively USED
- **Exported + type-only importers only:** USED (type-only)
- **Exported + zero importers:** LIKELY DEAD (the LLM confirms based on other signals like entry points, CLI commands, etc.)
- **Not exported:** internal to the file; the LLM checks local usage within the source

## Build Process

The graph is built synchronously during Phase 4 (Usage Graph) of the pipeline:

1. Construct an export map from all tasks: `filePath -> Set<exportedSymbolNames>`
2. For each file, read the source and extract all import relationships
3. For each import, resolve the specifier to a project-relative path
4. Record the import in the appropriate map (runtime or type-only), keyed by `"symbol::sourceFile"`
5. Skip self-imports (a file importing from itself)

After building, the function logs diagnostic stats: total runtime imports, type-only imports, total exports, and orphan count (exported symbols imported by zero files).

## Performance

The usage graph build is fast because it is purely local:

- No API calls
- No AST parsing (regex-based extraction is sufficient for import statements)
- Single pass over all files
- Typically completes in under 1 second even for large projects

The pipeline display shows the edge count after completion:

```
usage graph -- 847 edges
```
