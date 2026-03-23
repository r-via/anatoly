# Data Flow

> A detailed walkthrough of how source files enter the Anatoly pipeline, get transformed into structured audit data, and exit as actionable Markdown reports.

## Overview

`anatoly run` executes a deterministic, multi-stage pipeline. Each stage produces typed artifacts that are written to the `.anatoly/` state directory, making the pipeline resumable and cache-friendly. The three top-level phases are **Input** (scan & index), **Processing** (triage, RAG, evaluate), and **Output** (merge, deliberate, report).

All inter-stage communication is done through typed JSON files validated by Zod schemas in `src/schemas/`. The LLM is only invoked during the Evaluation phase; every other stage runs entirely in-process.

---

## Full Pipeline Diagram

```mermaid
flowchart TD
    A([fa:fa-terminal anatoly run]) --> B

    subgraph INPUT ["① Input Phase"]
        B[config-loader.ts\nloadConfig] --> C[scanner.ts\nscanProject]
        C -->|Task[]| D[usage-graph.ts\nbuildUsageGraph]
        C -->|Task[]| E[estimator.ts\nestimateTasksTokens]
        C -->|Task[]| T[triage.ts\ntriageFile]
    end

    subgraph RAG ["② RAG Indexing (optional)"]
        T -->|evaluate list| R1[rag/orchestrator.ts\nindexProject]
        R1 --> R2[rag/indexer.ts\nprocessFileForIndex]
        R2 --> R3[rag/embeddings.ts\nEmbed via Xenova / Docker]
        R3 --> R4[rag/vector-store.ts\nVectorStore.upsert]
        R4 --> R5[(LanceDB\n.anatoly/rag/)]
    end

    subgraph EVAL ["③ Evaluation Phase (per file, concurrent)"]
        T -->|evaluate list| FE[file-evaluator.ts\nevaluateFile]
        D -->|UsageGraph| FE
        R5 -->|SimilarityResult[]| FE

        FE --> AX1[axes/utility.ts]
        FE --> AX2[axes/duplication.ts]
        FE --> AX3[axes/correction.ts]
        FE --> AX4[axes/overengineering.ts]
        FE --> AX5[axes/tests.ts]
        FE --> AX6[axes/best-practices.ts]
        FE --> AX7[axes/documentation.ts]

        AX1 & AX2 & AX3 & AX4 & AX5 & AX6 & AX7 -->|AxisResult| AE[axis-evaluator.ts\nrunSingleTurnQuery]
        AE <-->|Claude Agent SDK| LLM[(Claude API)]
        AE -->|AxisResult[]| AM[axis-merger.ts\nmergeAxisResults]
        AM -->|ReviewFile| DEL{deliberation\nenabled?}
        DEL -->|yes| DL[deliberation.ts\nOpus pass]
        DEL -->|no| RW
        DL -->|refined ReviewFile| RW[review-writer.ts\nwriteReviewOutput]
        RW --> FS[(fa:fa-folder .anatoly/\nreviews/*.rev.json)]
    end

    subgraph OUTPUT ["④ Output Phase"]
        FS --> REP[reporter.ts\ngenerateReport]
        REP --> MD([fa:fa-file-alt report.md])
        REP --> BADGE([README.md badge])
    end

    style INPUT fill:#1e293b,stroke:#334155,color:#e2e8f0
    style RAG fill:#1e3a5f,stroke:#2563eb,color:#e2e8f0
    style EVAL fill:#1c2a1e,stroke:#16a34a,color:#e2e8f0
    style OUTPUT fill:#2d1e3e,stroke:#7c3aed,color:#e2e8f0
```

---

## Stage 1 — Input Phase

### Config Loading

The pipeline starts by loading and validating `.anatoly.yml` with `loadConfig()` from `src/utils/config-loader.ts`. The resolved `Config` object governs every downstream decision: which axes are enabled, which Claude model to use, concurrency limits, RAG settings, and scan globs.

### File Scanning (`src/core/scanner.ts`)

`scanProject(projectRoot, config)` discovers every file that matches the `scan.include` / `scan.exclude` globs, then parses each one:

1. **Language detection** via `src/core/language-detect.ts` — identifies TypeScript, JavaScript, Python, Go, etc., and optionally a framework (React, Next.js, …).
2. **AST parsing** via `web-tree-sitter` + `tree-sitter-typescript`. If tree-sitter fails, `src/core/language-adapters.ts` falls back to heuristic regex extraction.
3. **Symbol extraction** — every function, class, method, hook, type alias, constant, and enum is captured as a `SymbolInfo` with `line_start`, `line_end`, `exported`, and `kind`.
4. **SHA-256 hashing** — `computeFileHash()` produces the file's content hash. Files whose hash matches a `DONE` entry in `progress.json` are skipped automatically (cache hit).

The output is a `Task[]`, each written atomically to `.anatoly/tasks/<file>.task.json`.

```typescript
// src/core/scanner.ts
const { tasks, skippedCount } = await scanProject(
  '/home/user/myproject',
  config
)
// tasks[0] shape:
// {
//   version: 1,
//   file: 'src/api/router.ts',
//   hash: 'f3a9...',
//   symbols: [{ name: 'createRouter', kind: 'function', exported: true, line_start: 12, line_end: 78 }],
//   language: 'typescript',
//   parse_method: 'ast',
//   framework: 'express'
// }
```

### Usage Graph (`src/core/usage-graph.ts`)

`buildUsageGraph(tasks, projectRoot)` performs a full static import analysis across the scanned task list. It produces a `UsageGraph` that maps every exported symbol to the set of files that import it. This graph is later injected into the `utility` axis context so the LLM can accurately distinguish live exports from dead code.

### Triage (`src/core/triage.ts`)

`triageFile(task, config)` classifies each `Task` before any LLM call is made:

| Classification | Criteria | Outcome |
|---|---|---|
| `skip` | Barrel re-exports, type-only files, constants-only modules, generated files | Synthetic `CLEAN` review, no LLM call |
| `evaluate` | All other files | Proceeds to evaluation |

Skipped files receive a synthetic `ReviewFile` with `verdict: 'CLEAN'` and are immediately written to `.anatoly/reviews/`.

---

## Stage 2 — RAG Indexing (Optional)

When `rag.enabled: true` in config, `indexProject()` from `src/rag/orchestrator.ts` runs before evaluation.

### Indexing Pipeline

1. **Function card construction** (`src/rag/indexer.ts`) — for each function/method symbol, builds a `FunctionCard` containing the signature, a `behavioralProfile` string, `keyConcepts[]`, `complexityScore`, and a body SHA-256 hash for cache invalidation.
2. **Code embedding** (`src/rag/embeddings.ts`) — each card is embedded with a code-specific transformer model (Xenova local or Docker TEI). GPU availability is detected via `src/rag/hardware-detect.ts` to select the fastest backend.
3. **Optional NLP dual embedding** (`src/rag/nlp-summarizer.ts`) — an LLM generates a natural-language summary of each function, which is embedded separately. At query time, results from both vectors are fused via `VectorStore.hybridSearch()`.
4. **Database upsert** (`src/rag/vector-store.ts`) — cards are upserted into a LanceDB table at `.anatoly/rag/`. Unchanged cards (same `bodyHash`) are skipped.
5. **Doc indexing** (`src/rag/doc-indexer.ts`) — Markdown sections from the project's `/docs/` directory are also embedded and stored, enabling the `documentation` axis to find the most relevant pages for each file.

```typescript
// src/rag/orchestrator.ts
const ragResult = await indexProject({
  projectRoot: '/home/user/myproject',
  tasks,
  config,
  pipelineState,
})
// ragResult.vectorStore is passed downstream to file-evaluator.ts
```

At query time, the `duplication` axis calls `vectorStore.search(queryVector, 10)` or `vectorStore.hybridSearch(codeVec, nlpVec, config.rag.code_weight)` to retrieve `SimilarityResult[]` for each function being evaluated.

---

## Stage 3 — Evaluation Phase

This is the core of the pipeline. `evaluateFile()` from `src/core/file-evaluator.ts` is called for each non-skipped file. Files are processed concurrently up to `config.llm.concurrency` (default: 4).

### AxisContext Assembly

Before invoking any axis, `evaluateFile()` assembles an `AxisContext` object:

```typescript
interface AxisContext {
  task: Task                        // file metadata & symbol list
  fileContent: string               // raw source code
  config: Config
  projectRoot: string
  usageGraph?: UsageGraph           // import/export graph (for utility axis)
  preResolvedRag?: PreResolvedRagEntry[]  // RAG hits per function (for duplication axis)
  fileDeps?: FileDependencyContext   // resolved runtime + type-only deps
  projectTree?: string              // compact ASCII directory tree
  testFileContent?: string          // co-located test file, if found
  docsTree?: string | null          // project /docs/ outline
  relevantDocs?: RelevantDoc[]      // most relevant doc pages (via RAG or convention)
  conversationDir?: string          // path for transcript storage
  semaphore?: Semaphore             // global LLM concurrency limiter
}
```

### The 7 Axes

All seven axis evaluators implement the same interface: `evaluate(ctx: AxisContext, abort: AbortController): Promise<AxisResult>`. They run concurrently via `Promise.allSettled()`.

| Axis | Module | What It Evaluates | Per-Symbol Verdict Values |
|---|---|---|---|
| `correction` | `axes/correction.ts` | Syntax errors, logic bugs, type errors | `OK` / `NEEDS_FIX` / `ERROR` |
| `utility` | `axes/utility.ts` | Dead code, unused exports, low-value symbols | `USED` / `DEAD` / `LOW_VALUE` |
| `duplication` | `axes/duplication.ts` | Near-duplicate functions across files (via RAG) | `UNIQUE` / `DUPLICATE` |
| `overengineering` | `axes/overengineering.ts` | Excessive abstraction, unnecessary complexity | `LEAN` / `ACCEPTABLE` / `OVER` |
| `tests` | `axes/tests.ts` | Test coverage quality | `GOOD` / `WEAK` / `NONE` |
| `best_practices` | `axes/best-practices.ts` | Language-specific rules (17 rules per language) | `PASS` / `FAIL` per rule |
| `documentation` | `axes/documentation.ts` | JSDoc coverage, concept-to-docs mapping | `DOCUMENTED` / `PARTIAL` / `UNDOCUMENTED` |

### LLM Invocation (`src/core/axis-evaluator.ts`)

Each axis delegates to `runSingleTurnQuery()`, which:

1. Selects the correct system prompt via `src/core/prompt-resolver.ts` — prompts cascade from framework-specific → language-specific → default.
2. Constructs the user message by embedding the file content, symbol list, pre-computed context (usage graph, RAG hits, relevant docs, etc.).
3. Calls `query()` from `@anthropic-ai/claude-agent-sdk` with the configured model.
4. Extracts the JSON payload from the response using `extractJson()` (`src/utils/extract-json.ts`).
5. Validates the result against the axis-specific Zod schema.
6. Returns an `AxisResult` with verdicts, actions, token counts, cost, and duration.

A global `Semaphore` (capacity = `config.llm.sdk_concurrency`, default: 8) prevents unbounded concurrent SDK calls across all files and axes.

### Result Merging (`src/core/axis-merger.ts`)

`mergeAxisResults(task, axisResults)` combines all seven `AxisResult` objects into a single `ReviewFile`:

- **Per-symbol verdicts** are merged field-by-field (each axis writes its own column).
- **Coherence rules** are applied — for example, a symbol with `utility: 'DEAD'` automatically receives `tests: 'NONE'` (no point testing dead code).
- **Actions** from all axes are de-duplicated, sorted by severity, and assigned sequential IDs.
- **File verdict** is computed: `CRITICAL` if any symbol has `correction: 'ERROR'` with confidence ≥ 60; `NEEDS_REFACTOR` if any actionable issue exists with confidence ≥ 60; `CLEAN` otherwise.
- **`axis_meta`** records per-axis cost, duration, model name, and token counts.

### Optional Deliberation (`src/core/deliberation.ts`)

When `llm.deliberation: true`, the merged `ReviewFile` is sent to `deliberation_model` (default: `claude-opus-4-6`) for a final review pass. Opus may:

- Reclassify borderline verdicts (e.g., lower confidence `DEAD` → `LOW_VALUE`).
- Remove actions that don't apply after full context review.
- Record reclassifications in `src/core/correction-memory.ts` so future runs can pre-calibrate.

The deliberation pass produces a `DeliberationResult` embedded in the final `ReviewFile.deliberation` field.

### Review Output (`src/core/review-writer.ts`)

`writeReviewOutput()` atomically writes two files per evaluated source file:

- `.anatoly/reviews/<file>.rev.json` — machine-readable `ReviewFile` (Zod-validated JSON, v2 schema)
- `.anatoly/reviews/<file>.rev.md` — human-readable Markdown rendition

`src/core/progress-manager.ts` updates the file's status from `IN_PROGRESS` → `DONE` (or `ERROR`) in `.anatoly/cache/progress.json` immediately after.

---

## Stage 4 — Output Phase

### Report Generation (`src/core/reporter.ts`)

`generateReport(projectRoot)` aggregates all `.rev.json` files and produces the final report:

1. **Load reviews** — reads every `ReviewFile` from `.anatoly/reviews/`.
2. **Classify** — groups files into `clean`, `findings`, and `errors` buckets.
3. **Count** — tallies issues per axis and per severity level.
4. **Synthesize** — produces ranked, actionable recommendations.
5. **Write** — emits `.anatoly/runs/<runId>/report.md`.

The global verdict follows the same `CRITICAL` → `NEEDS_REFACTOR` → `CLEAN` hierarchy applied at the file level.

```typescript
// src/core/reporter.ts
const { reportPath, data } = await generateReport('/home/user/myproject')
// data.globalVerdict: 'NEEDS_REFACTOR'
// data.fileCount: 42
// data.criticalFiles: ['src/api/auth.ts']
// data.actionCount: 17
```

### Badge Injection

If `badge.enabled: true`, the pipeline injects an SVG audit badge into the project's `README.md` reflecting the global verdict (`CLEAN` / `NEEDS_REFACTOR` / `CRITICAL`).

---

## Artifact Layout

All pipeline state is contained within `.anatoly/` at the project root:

```
.anatoly/
├── cache/
│   ├── progress.json        # FileStatus per path (PENDING / IN_PROGRESS / DONE / ERROR)
│   └── rag-code.cache       # Code embedding cache (bodyHash → vector)
├── tasks/
│   └── src/api/router.ts.task.json   # Task (scanned metadata per file)
├── reviews/
│   ├── src/api/router.ts.rev.json    # ReviewFile v2 (machine-readable)
│   └── src/api/router.ts.rev.md      # Rendered review (human-readable)
├── logs/
│   └── src/api/router.ts/            # Per-axis LLM transcripts
├── rag/
│   └── (LanceDB tables)              # Vector store (code + NLP embeddings)
└── runs/
    └── 20260322-143201/
        └── report.md                 # Final aggregated audit report
```

---

## Concurrency Model

Two independent concurrency controls prevent resource exhaustion:

| Setting | Config Key | Default | Controls |
|---|---|---|---|
| **File concurrency** | `llm.concurrency` | `4` | Number of files evaluated in parallel |
| **SDK concurrency** | `llm.sdk_concurrency` | `8` | Max simultaneous in-flight Claude API calls (global semaphore across all files × axes) |

Within a single file, all 7 axes are dispatched with `Promise.allSettled()` — a failure in one axis never blocks the others.

---

## Examples

### Inspecting a `Task` produced by `scanProject`

```typescript
import { scanProject } from './src/core/scanner.js'
import { loadConfig } from './src/utils/config-loader.js'

const projectRoot = process.cwd()
const config = loadConfig(projectRoot)

const { tasks, skippedCount } = await scanProject(projectRoot, config)

const example = tasks.find(t => t.file === 'src/api/router.ts')!
console.log(example)
// {
//   version: 1,
//   file: 'src/api/router.ts',
//   hash: 'a3f9b12c...',
//   symbols: [
//     { name: 'createRouter', kind: 'function', exported: true, line_start: 12, line_end: 78 },
//     { name: 'RouteHandler', kind: 'type',     exported: true, line_start:  8, line_end:  9 }
//   ],
//   language: 'typescript',
//   parse_method: 'ast',
//   framework: 'express',
//   scanned_at: '2026-03-22T14:32:01.000Z'
// }
```

### Evaluating a single file programmatically

```typescript
import { evaluateFile } from './src/core/file-evaluator.js'
import { buildUsageGraph } from './src/core/usage-graph.js'
import { loadConfig } from './src/utils/config-loader.js'
import { loadTasks } from './src/utils/cache.js'

const projectRoot = process.cwd()
const config = loadConfig(projectRoot)
const tasks = loadTasks(projectRoot)
const usageGraph = buildUsageGraph(tasks, projectRoot)

const result = await evaluateFile({
  task: tasks.find(t => t.file === 'src/api/router.ts')!,
  projectRoot,
  config,
  usageGraph,
  vectorStore: undefined, // pass VectorStore instance when RAG is enabled
})

console.log(result.review.verdict)           // 'CLEAN' | 'NEEDS_REFACTOR' | 'CRITICAL'
console.log(result.review.symbols[0].utility) // 'USED' | 'DEAD' | 'LOW_VALUE'
console.log(result.review.actions)            // Action[]
```

### Reading the merged ReviewFile from disk

```typescript
import { readFileSync } from 'node:fs'
import { ReviewFileSchema } from './src/schemas/review.js'

const raw = readFileSync('.anatoly/reviews/src/api/router.ts.rev.json', 'utf8')
const review = ReviewFileSchema.parse(JSON.parse(raw))

for (const sym of review.symbols) {
  if (sym.utility === 'DEAD') {
    console.log(`Dead code: ${sym.name} (line ${sym.line_start})`)
  }
  if (sym.duplication === 'DUPLICATE' && sym.duplicate_target) {
    console.log(`Duplicate of ${sym.duplicate_target.symbol} in ${sym.duplicate_target.file}`)
  }
}
```

### Running the full pipeline from Node

```typescript
import { run } from './src/commands/run.js'

await run({
  projectRoot: '/home/user/myproject',
  configPath: '.anatoly.yml',
  rag: true,
  deliberation: true,
  concurrency: 4,
})
// Writes: .anatoly/reviews/**/*.rev.json
//         .anatoly/runs/<id>/report.md
//         README.md (badge)
```

---

## See Also

- [Architecture Overview](./01-Overview.md) — high-level component map and design principles.
- [Module Inventory](./02-Module-Inventory.md) — full reference for every module in `src/`.
- [RAG System](../03-Core-Concepts/04-RAG-System.md) — deep dive into vector indexing and hybrid search.
- [Evaluation Axes](../03-Core-Concepts/02-Evaluation-Axes.md) — per-axis prompt design, verdict semantics, and coherence rules.
- [Configuration Reference](../04-Reference/01-Configuration.md) — all `.anatoly.yml` keys with defaults.
- [State & Caching](../04-Reference/03-State-and-Caching.md) — `progress.json` schema and cache invalidation logic.
