# RAG Semantic Index

Anatoly builds a local vector index of every function, method, and hook in the codebase. The duplication axis queries this index at review time to surface semantically similar code — renamed variables, refactored patterns, and cross-file duplicates that grep cannot find.

**Zero API cost.** Embeddings are computed locally using [Jina Embeddings V2 Base Code](https://huggingface.co/jinaai/jina-embeddings-v2-base-code). No tokens are consumed during indexing.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [FunctionCard Schema](#functioncard-schema)
- [Embedding Model](#embedding-model)
- [Vector Store (LanceDB)](#vector-store-lancedb)
- [Indexing Pipeline](#indexing-pipeline)
- [Cache and Incremental Re-indexing](#cache-and-incremental-re-indexing)
- [Garbage Collection](#garbage-collection)
- [Search API](#search-api)
- [Dimension Mismatch Auto-Rebuild](#dimension-mismatch-auto-rebuild)
- [CLI: `rag-status`](#cli-rag-status)
- [Configuration](#configuration)
- [File Layout](#file-layout)

---

## Architecture Overview

```
src/rag/
├── types.ts          # FunctionCard Zod schema, SimilarityResult, RagStats
├── embeddings.ts     # Jina model loading, embed(), buildEmbedCode()
├── indexer.ts         # buildFunctionCards(), complexity, cache I/O
├── orchestrator.ts    # indexProject() — full indexing pipeline
└── vector-store.ts    # LanceDB wrapper: upsert, search, GC, rebuild
```

Data flow:

```
AST scan (task.json)
  → buildFunctionCards()     extract symbols from AST (no LLM)
  → embedCards()             embed code locally (Jina, 768-dim)
  → VectorStore.upsert()     store in LanceDB
  → cache.json               record file hashes for incremental re-index
```

---

## FunctionCard Schema

**File:** `src/rag/types.ts`

Each indexed function produces one `FunctionCard`:

| Field | Type | Constraint | Description |
|-------|------|------------|-------------|
| `id` | string | 16-char hex | Deterministic SHA-256 of `filePath:lineStart-lineEnd` |
| `filePath` | string | — | Source file path |
| `name` | string | — | Function/method/hook name |
| `signature` | string | max 200 chars | First 1–3 lines up to `{` or `=>` |
| `summary` | string? | max 400 chars | Optional text summary (unused in current indexer) |
| `keyConcepts` | string[]? | — | Optional concept tags (unused in current indexer) |
| `behavioralProfile` | enum? | — | `pure` · `sideEffectful` · `async` · `memoized` · `stateful` · `utility` |
| `complexityScore` | integer | 1–5 | Cyclomatic complexity bucket |
| `calledInternals` | string[] | — | Names of other symbols called within this function |
| `lastIndexed` | string | ISO 8601 | Timestamp of last indexation |

**Indexed symbol kinds:** `function`, `method`, `hook`. Types, classes, constants, enums, and variables are excluded.

### Complexity Scoring

Computed by `computeComplexity()` — counts branching constructs (`if`, `else if`, `case`, `&&`, `||`, ternary `?`, `catch`) and maps to a 1–5 scale:

| Cyclomatic Complexity | Score |
|-----------------------|-------|
| 1–2 | 1 |
| 3–5 | 2 |
| 6–10 | 3 |
| 11–20 | 4 |
| 21+ | 5 |

### Called Internals

`extractCalledInternals()` scans the function body for calls to other symbols in the same file. Matches `name(` or `name<` patterns, deduplicated.

---

## Embedding Model

| Property | Value |
|----------|-------|
| Model | `jinaai/jina-embeddings-v2-base-code` |
| Dimensions | 768 |
| Runtime | `@xenova/transformers` (ONNX, CPU) |
| Pooling | mean |
| Normalization | yes (unit vectors) |
| Max code chars | 1500 (truncated with `// ... truncated` marker) |

**File:** `src/rag/embeddings.ts`

The model is downloaded at `npm postinstall` and loaded lazily on first use (singleton). No GPU required.

### Embed Format

`buildEmbedCode()` constructs the text passed to the embedder:

```
// functionName
export function functionName(args: Type): ReturnType {
  // ... function body (up to 1500 chars)
```

The name comment prefix and signature help the model weight semantic meaning over syntax.

---

## Vector Store (LanceDB)

**File:** `src/rag/vector-store.ts`

| Property | Value |
|----------|-------|
| Engine | [LanceDB](https://lancedb.com/) (embedded, serverless) |
| Location | `.anatoly/rag/lancedb/` |
| Table | `function_cards` |
| Distance metric | L2 (squared euclidean) |
| Similarity conversion | `cosine_similarity = 1 - L2² / 2` |
| Min similarity score | 0.75 (default) |
| Default result limit | 8 |

### Stored Fields

Each row contains all FunctionCard fields plus a `vector: number[768]` column. Array fields (`keyConcepts`, `calledInternals`) are JSON-serialized strings in the store and deserialized on read.

### Security

- **ID validation:** `sanitizeId()` enforces 16-char hex strings, preventing injection in filter predicates
- **Path escaping:** `sanitizeFilePath()` escapes single quotes in file paths for WHERE clauses

---

## Indexing Pipeline

**File:** `src/rag/orchestrator.ts` — `indexProject()`

```
1. init VectorStore
2. rebuild (if --rebuild-rag)
3. pre-warm embedding model (embed empty string)
4. load cache.json
5. garbage-collect stale entries (files removed from project)
6. filter tasks to those with function/method/hook symbols
7. filter to tasks where any symbol needs re-indexing (cache miss)
8. concurrent worker pool:
   a. buildFunctionCards() from AST + source
   b. filter cards by cache (needsReindex)
   c. embedCards() — local Jina embedding
   d. accumulate results
9. sequential upsert into VectorStore (per-file batches)
10. update cache entries for upserted cards
11. atomic cache write (single file I/O)
```

**Concurrency:** Controlled by `llm.concurrency` (default 4). Embedding is CPU-bound, so concurrency speeds up I/O-heavy portions while embedding serializes naturally.

**Interruption:** The worker pool checks `isInterrupted()` between files — Ctrl+C triggers graceful shutdown with partial results preserved.

---

## Cache and Incremental Re-indexing

**File:** `src/rag/indexer.ts`

**Cache location:** `.anatoly/rag/cache.json`

```json
{
  "entries": {
    "a1b2c3d4e5f67890": "sha256-of-source-file",
    "..."
  }
}
```

Each entry maps a function ID (16-char hex) to the SHA-256 hash of the source file at the time of indexation.

**`needsReindex(cache, card, fileHash)`** returns `true` when:
- The function ID is not in the cache, OR
- The cached hash differs from the current file hash

On the second run, only modified files are re-embedded. Unchanged files skip at zero cost.

**Cache I/O:**
- `loadRagCache()` — reads cache from disk; returns empty cache if missing or corrupted
- `saveRagCache()` — atomic write via `atomicWriteJson()` (write to temp file, then rename)

---

## Garbage Collection

At the start of each indexing run, `indexProject()` compares files currently in the project (from AST scan) against files in the vector index:

```typescript
for (const orphan of indexedFiles) {
  if (!currentFiles.has(orphan)) {
    await store.deleteByFile(orphan);
  }
}
```

Deleted or renamed source files have their cards removed automatically.

---

## Search API

### `search(queryEmbedding, limit?, minScore?)`

Vector similarity search. Returns up to `limit` results (default 8) above `minScore` (default 0.75).

LanceDB returns squared L2 distances. The store converts to cosine similarity:

```typescript
cosine_similarity = 1 - L2² / 2
```

This works because all vectors are normalized to unit length.

### `searchById(functionId, limit?, minScore?)`

Looks up the card by ID, retrieves its embedding, then calls `search()`. Self-matches are excluded by both ID and file+name (catches stale entries from re-indexation).

### `searchByName(name)`

Case-insensitive substring match across all card names. Used by the `rag-status` command for function inspection.

### `listAll()`

Returns all cards without embedding vectors. Used for stats and listing.

---

## Dimension Mismatch Auto-Rebuild

On `VectorStore.init()`, if the stored vectors have a different dimension than `EMBEDDING_DIM` (768), the store automatically:

1. Drops and recreates the `function_cards` table
2. Clears `cache.json` to force full re-indexation

This handles model upgrades transparently (e.g., migrating from a 384-dim model to Jina 768-dim).

---

## CLI: `rag-status`

```bash
npx anatoly rag-status           # Summary stats
npx anatoly rag-status --all     # List all indexed functions
npx anatoly rag-status --json    # JSON output
npx anatoly rag-status <name>    # Inspect a specific function + find similar
```

### Summary Mode (default)

```
RAG Index Status
  Total functions indexed: 247
  Total files indexed: 45
  Last indexed: 2026-03-15T14:23:45.000Z
```

### List Mode (`--all`)

Lists every indexed function with file path, complexity score, and called internals.

### Function Inspection (`<name>`)

Searches by name, displays the matching card details, then runs a similarity search to show the top similar functions with their cosine similarity scores.

---

## Configuration

In `.anatoly.yml`:

```yaml
rag:
  enabled: true       # default: true — set false to skip indexing entirely
```

CLI flags:

| Flag | Description |
|------|-------------|
| `--no-rag` | Skip RAG indexing phase |
| `--rebuild-rag` | Drop and rebuild the entire vector index |

When RAG is disabled (`--no-rag` or `rag.enabled: false`), the duplication axis still runs but without semantic context — it relies only on grep-based detection.

---

## File Layout

```
.anatoly/
└── rag/
    ├── lancedb/           # LanceDB data directory (binary files)
    │   └── function_cards.lance/
    └── cache.json         # Function ID → file hash map
```

The entire `.anatoly/rag/` directory can be safely deleted — it will be rebuilt on the next `run` or `rag-status` command.

---

See also: [How It Works](how-it-works.md) · [Analysis Axes](analysis-axes.md) · [Architecture](architecture.md) · [Schemas](schemas.md)
