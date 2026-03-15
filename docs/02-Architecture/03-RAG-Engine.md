# RAG Engine

Anatoly includes a local Retrieval-Augmented Generation (RAG) engine that indexes every function in the codebase and enables semantic similarity search. The engine powers the duplication axis by finding candidate duplicates across the project without requiring the LLM to have seen every file.

## Architecture

```
Source Files
     |
     v
AST Analysis (buildFunctionCards)
     |
     v
FunctionCards (signature, complexity, calledInternals)
     |
     v
Code Embedding (jinaai/jina-embeddings-v2-base-code, 768-dim)
     |
     v
LanceDB Vector Store (.anatoly/rag/lancedb/)
     |
     v
Similarity Search (cosine similarity via L2 distance)
     |
     v
Pre-resolved RAG results injected into duplication axis prompt
```

## Embedding Model

Anatoly uses the `jinaai/jina-embeddings-v2-base-code` model via the `@xenova/transformers` library. This is a code-specialized embedding model that runs entirely locally -- no API calls, no network requests, zero cost per embedding.

- **Model:** `jinaai/jina-embeddings-v2-base-code`
- **Dimensions:** 768
- **Runtime:** `@xenova/transformers` (ONNX-based, runs on CPU)
- **Download:** model weights are downloaded at `postinstall` time and cached locally
- **Max input:** source code is truncated to 1500 characters per function to stay within the model's effective window

The embedding input is constructed as:

```
// functionName
functionSignature
functionBody (truncated to 1500 chars)
```

## Vector Store

The vector store is built on [LanceDB](https://lancedb.com/), an embedded columnar database optimized for vector search.

- **Location:** `.anatoly/rag/lancedb/`
- **Table:** `function_cards` -- single table storing all indexed functions
- **Distance metric:** L2 (squared Euclidean). For normalized vectors, cosine similarity is derived as `1 - L2_squared / 2`.
- **Minimum similarity threshold:** 0.75 (configurable per search call)
- **Result limit:** 8 candidates per query (default)

The store supports:
- **Upsert:** delete-then-add by function ID (16-char hex hash of `filePath:lineStart-lineEnd`)
- **Search by embedding:** direct vector similarity search
- **Search by ID:** look up a function's embedding, then find its nearest neighbors (excluding self-matches)
- **Garbage collection:** stale entries for deleted files are removed at the start of each indexing run
- **Dimension mismatch detection:** if the stored vectors have a different dimension than the current model, the index is automatically rebuilt

Input sanitization prevents injection in filter predicates: function IDs are validated as 16-char hex strings, and file paths have single quotes escaped.

## FunctionCard

A `FunctionCard` is the unit of indexing. Each card represents a single function, method, or hook and contains:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Deterministic 16-char hex hash of `filePath:lineStart-lineEnd` |
| `filePath` | string | Project-relative path to the source file |
| `name` | string | Function/method name |
| `signature` | string | Extracted signature (first 1-3 lines up to opening brace, max 200 chars) |
| `summary` | string | Optional short description (max 400 chars). **Dead field:** currently never populated by the indexer. |
| `keyConcepts` | string[] | Optional concept tags. **Dead field:** currently never populated by the indexer. |
| `behavioralProfile` | enum (optional) | One of: `pure`, `sideEffectful`, `async`, `memoized`, `stateful`, `utility`. Optional -- may be omitted. |
| `complexityScore` | 1-5 | Cyclomatic complexity mapped to a 5-point scale |
| `calledInternals` | string[] | Names of other functions in the same file that this function calls |
| `lastIndexed` | ISO datetime | Timestamp of last indexing |

The complexity score is computed locally from the function body by counting branching constructs (if, else if, case, &&, ||, ternary, catch) and mapping to a 1-5 scale:

| Cyclomatic Complexity | Score |
|-----------------------|-------|
| 1-2 | 1 |
| 3-5 | 2 |
| 6-10 | 3 |
| 11-20 | 4 |
| 21+ | 5 |

## Semantic Duplication Detection

During the Review phase, before the duplication axis evaluator runs, a pre-resolution step queries the vector store for each function in the file under review:

1. Compute the function's ID from its file path and line range
2. Look up the function's embedding in the store
3. Search for nearest neighbors (top 8, minimum 0.75 cosine similarity)
4. Exclude self-matches (same ID or same file+name)

The results are injected into the duplication axis prompt along with:
- Candidate function name, file path, and similarity score
- Candidate signature and complexity score
- Candidate internal function calls
- Candidate source code (up to 50 lines, read directly from disk)

This gives the LLM concrete code-to-code evidence to decide whether two functions are true duplicates or merely similar.

When RAG is disabled or the vector store is empty, the duplication axis receives no candidates and defaults all symbols to `UNIQUE` with 90% confidence.

## Caching and Incremental Indexing

The RAG engine uses a hash-based cache to avoid re-embedding unchanged functions:

- **Cache location:** `.anatoly/rag/cache.json`
- **Cache structure:** `{ entries: { [functionId]: fileHash } }`
- **Cache logic:** a function is re-indexed only if its file's content hash differs from the cached hash
- **Cache writes:** a single atomic write at the end of the indexing run (not per-function)

On a typical incremental run where few files have changed, the vast majority of functions are skipped during indexing. Only new or modified functions are embedded and upserted.

The `--rebuild-rag` flag drops the entire LanceDB table and clears the cache, forcing a full re-index.

## Zero API Cost

The entire RAG pipeline -- from AST analysis through embedding to vector search -- runs locally with no external API calls. This was a deliberate design choice:

- **Indexing:** function cards are built from AST data (no LLM summarization)
- **Embedding:** the Xenova transformer model runs on-device
- **Storage:** LanceDB is an embedded database with no server component
- **Search:** vector similarity is computed locally

The only API cost in the entire pipeline comes from the axis evaluator LLM calls in the Review phase and the optional Deliberation phase.
