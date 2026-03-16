# ADR-01: Local RAG over API-Based RAG

**Status:** Accepted
**Date:** 2025-01-15
**Deciders:** Core team

## Context

Anatoly needs semantic search to detect cross-file duplication — functions that do the same thing but with different names, refactored signatures, or reorganized logic. Grep and AST matching cannot catch these cases; only vector similarity over code embeddings can.

The question was whether to use a cloud-hosted embedding API (OpenAI, Cohere, Voyage, etc.) or run embeddings entirely on the local machine.

### Forces

- **Cost:** Anatoly already makes heavy use of the Claude API for its 6-axis evaluation pipeline (6 LLM calls per file). Adding embedding API calls for every function in the codebase would compound costs significantly.
- **Privacy:** Users audit proprietary codebases. Sending every function body to a third-party embedding API is a non-starter for many enterprise teams.
- **Offline capability:** Developers frequently work on planes, trains, or behind firewalls. The RAG index should build and query without network access.
- **Latency:** Embedding hundreds of functions through a remote API introduces network round-trips. Local inference eliminates this.
- **Simplicity:** Fewer external dependencies, fewer API keys to configure, fewer failure modes.

## Decision

Use **Jina Embeddings V2 Base Code** (`jinaai/jina-embeddings-v2-base-code`) running locally via `@xenova/transformers` (ONNX Runtime) for embedding generation, and **LanceDB** as the local vector store.

### Embedding model

The model is loaded lazily as a singleton (`src/rag/embeddings.ts`). It produces **768-dimensional** normalized vectors using mean pooling. Input text is truncated to 1,500 characters to stay within the model's effective window, with a prefix that includes the function name and signature to improve retrieval quality.

```
EMBEDDING_MODEL = 'jinaai/jina-embeddings-v2-base-code'
EMBEDDING_DIM   = 768
```

The model is downloaded once at `npm install` (postinstall hook) and loaded from the local cache on subsequent runs. Model size is approximately 30 MB.

### Vector store

LanceDB (`@lancedb/lancedb`) stores vectors in a columnar format under `.anatoly/rag/lancedb/` inside the project directory (`src/rag/vector-store.ts`). It supports:

- **Upsert** — delete-then-add by function ID, so re-indexation is incremental.
- **Similarity search** — L2 distance converted to cosine similarity (`1 - L2^2 / 2` for normalized vectors), with a configurable minimum score threshold (default 0.75).
- **Dimension mismatch auto-rebuild** — if the stored vectors have a different dimensionality than the current model (e.g., after a model upgrade), the index is automatically dropped and rebuilt.
- **No external server** — LanceDB is an embedded database. No Docker, no background process, no port conflicts.

### Function cards

Each indexed function is stored as a `FunctionCard` containing: ID, file path, name, signature, summary, key concepts, behavioral profile (pure/sideEffectful/async/memoized/stateful/utility), complexity score, and the list of internal functions it calls. This metadata is surfaced in the duplication axis prompt so the LLM can make informed comparisons beyond raw vector similarity.

## Consequences

### Positive

- **Zero API cost for indexing.** Embedding generation and vector storage are entirely local. The only API costs in Anatoly come from the Claude evaluation calls.
- **Full offline support.** After the initial model download, `anatoly scan` and `anatoly run --no-review` work without any network access.
- **Privacy by default.** Function source code never leaves the machine during indexing.
- **Fast incremental updates.** Only changed files are re-embedded (SHA-256 cache). Re-indexing a 500-file project after editing 3 files takes seconds.
- **Portable index.** The `.anatoly/rag/` directory can be committed or shared. No cloud state to synchronize.

### Negative

- **~30 MB model download** on first install (Jina ONNX). The optional Nomic Embed Code 7B via Ollama is ~4.7 GB but provides significantly better embeddings.
- **CPU-bound embedding (ONNX).** On machines without GPU acceleration, embedding a large codebase (1,000+ functions) can take 30-60 seconds. With Ollama on GPU, this is much faster with native batching support.
- **768-dim vectors are larger than some cloud alternatives.** OpenAI's `text-embedding-3-small` offers 512-dim or 1536-dim options. The 768-dim models strike a good balance between quality and storage.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| **OpenAI Embeddings API** | Adds per-token cost, requires an OpenAI API key, sends code to a third party. Violates the zero-cost-for-indexing principle. |
| **Voyage Code 3** | Best-in-class code embeddings, but API-only. Same cost/privacy concerns as OpenAI. |
| **No RAG (grep-only duplication)** | Grep can find exact string matches but completely misses renamed variables, refactored logic, and cross-file patterns. The duplication axis would be severely limited. |
| **ChromaDB** | Requires a separate server process or in-process Python. LanceDB is a native embedded store with a Node.js SDK, better suited to a CLI tool. |

## Notes

The embedding model is now auto-selected at startup based on hardware and Ollama availability. When a GPU and Ollama are detected, Anatoly uses `manutic/nomic-embed-code` (7B) for higher-quality embeddings; otherwise it falls back to `jinaai/jina-embeddings-v2-base-code` (ONNX). The vector store automatically detects dimension mismatches and rebuilds the index, so model switches are seamless for users. Run `./scripts/setup-ollama.sh` to set up GPU-accelerated embeddings.
