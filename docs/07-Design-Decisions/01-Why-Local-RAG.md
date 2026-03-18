# ADR-01: Local RAG over API-Based RAG

**Status:** Accepted
**Date:** 2025-01-15
**Deciders:** Core team

## Context

Anatoly needs semantic search to detect cross-file duplication — functions that do the same thing but with different names, refactored signatures, or reorganized logic. Grep and AST matching cannot catch these cases; only vector similarity over code embeddings can.

The question was whether to use a cloud-hosted embedding API (OpenAI, Cohere, Voyage, etc.) or run embeddings entirely on the local machine.

### Forces

- **Cost:** Anatoly already makes heavy use of the Claude API for its 7-axis evaluation pipeline (7 LLM calls per file). Adding embedding API calls for every function in the codebase would compound costs significantly.
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

- **~30 MB model download** on first install (Jina ONNX). The optional Nomic Embed Code 7B via sentence-transformers sidecar is ~14 GB but provides significantly better embeddings.
- **CPU-bound embedding (ONNX).** On machines without GPU acceleration, embedding a large codebase (1,000+ functions) can take 30-60 seconds. With the sentence-transformers sidecar on GPU, this is much faster.
- **3584-dim vectors (7B model) are larger than cloud alternatives.** The ONNX fallback uses 768-dim. Both are larger than OpenAI's 512-dim option, but the quality difference justifies the storage.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| **OpenAI Embeddings API** | Adds per-token cost, requires an OpenAI API key, sends code to a third party. Violates the zero-cost-for-indexing principle. |
| **Voyage Code 3** | Best-in-class code embeddings, but API-only. Same cost/privacy concerns as OpenAI. |
| **No RAG (grep-only duplication)** | Grep can find exact string matches but completely misses renamed variables, refactored logic, and cross-file patterns. The duplication axis would be severely limited. |
| **ChromaDB** | Requires a separate server process or in-process Python. LanceDB is a native embedded store with a Node.js SDK, better suited to a CLI tool. |
| **Ollama** | Community port (`manutic/nomic-embed-code`) suffered from GGML_ASSERT crashes in Ollama 0.13+. Replaced by direct sentence-transformers sidecar for stability. |

## Embedding Strategy: Single vs Dual

Anatoly supports two embedding modes, auto-selected based on available hardware:

| Mode | Model | Dim | GPU | Dual NLP | Quality |
|------|-------|-----|-----|----------|---------|
| **advanced** (sidecar) | nomic-embed-code (code) + Qwen3-Embedding-8B (NLP) | 3584d + 4096d | Required (14 GB VRAM) | Yes — dedicated NLP model for semantics | Best |
| **lite** (ONNX fallback) | Jina v2 (code) + MiniLM (NLP) | 768d + 384d | Not needed | Yes — compensates Jina's code-only focus | Good |

**Why two tiers of models?**

In advanced mode, the nomic-embed-code 7B model handles code embedding (3584d) while Qwen3-Embedding-8B provides a dedicated NLP embedding (4096d) for semantic intent. This dual-sidecar approach gives the best quality across both dimensions.

In lite mode (ONNX fallback), Jina v2 is a pure code embedder that doesn't understand natural language intent, so the MiniLM NLP vector (384d) adds a complementary semantic signal.

**Auto-selection:** when the sidecar is running, advanced mode models (nomic-embed-code + Qwen3-Embedding-8B) are used automatically.

## Notes

The embedding models are auto-selected at startup based on hardware and sidecar availability. When a GPU is detected, Anatoly starts the sentence-transformers sidecar with `nomic-ai/nomic-embed-code` (3584d) for code and `Qwen/Qwen3-Embedding-8B` (4096d) for NLP. Without GPU, it falls back to Jina v2 (ONNX, 768d) for code with optional dual MiniLM NLP embedding (384d). The vector store automatically detects dimension mismatches and rebuilds the index, so model switches are seamless. Run `npx anatoly setup-embeddings` to set up both models, or the sidecar auto-starts with `anatoly run`.
