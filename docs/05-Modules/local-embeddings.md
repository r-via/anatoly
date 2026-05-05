# Setup Embeddings

> Configures the embedding backend used by the RAG index, selecting between ONNX in-process models and GPU-accelerated Docker containers based on detected hardware.

## Overview

`setup-embeddings` is the subsystem responsible for choosing and initialising the embedding pipeline that powers anatoly's semantic search. On first install the `postinstall` lifecycle hook (`scripts/download-model.js`) pre-fetches the default ONNX models so that no network access is required at runtime.

Embedding operates in **dual-vector** mode: every indexed function receives both a *code* vector (structural/syntactic semantics) and an *NLP* vector (natural-language semantics). These are stored separately in the LanceDB table at `.anatoly/rag/lancedb` and queried independently or combined for hybrid search.

The active configuration is persisted as `.anatoly/embeddings-ready.json` ([`EmbeddingsReadyFlag`](#embeddingsreadyflag)) and re-read on each invocation so subsequent runs do not repeat detection.

---

## Prerequisites

| Requirement | Condition |
|---|---|
| Node.js ≥ 20.19 | Always required |
| Docker daemon | Required for `advanced-gguf` and `advanced-fp16` backends |
| NVIDIA Container Toolkit | Required for `advanced-gguf` backend (GPU-accelerated containers) |
| NVIDIA GPU with ≥ 12 GB VRAM | Required for `advanced-gguf` backend |
| Provider API key (e.g. `OPENAI_API_KEY`) | Required for `external` backend — see [Embedding Providers guide](../03-Guides/03-Embedding-Providers.md) |

The `lite` backend (ONNX) has no external runtime dependencies beyond Node.js. The `external` backend has no GPU/Docker dependency — only an HTTPS-reachable embedding endpoint and an API key.

---

## CLI Command

Registered by `registerSetupEmbeddingsCommand(program: Command)` in `src/commands/setup-embeddings.ts`.

```bash
anatoly setup-embeddings [options]
```

| Option | Description |
|---|---|
| `--check` | Report current embedding setup status without modifying anything |
| `--ab-test` | Run an A/B quality comparison between `advanced-fp16` (TEI) and `advanced-gguf` (llama.cpp) and write results to `.anatoly/embeddings-ready.json` |

---

## Backends

Hardware detection is performed by `detectHardware()` in `src/rag/hardware-detect.ts`, which returns a `HardwareProfile`. The active backend is then resolved by `determineBackend(flag, hardware)`.

```typescript
type EmbeddingBackend = 'lite' | 'advanced-fp16' | 'advanced-gguf' | 'external'
```

`'advanced-fp16'` is a legacy A/B reference (TEI fp16); not selected at runtime — falls back to `lite`. `'advanced-gguf'` is mapped internally to provider `anatoly-local` over the SDK transport. `'external'` routes embeddings to a third-party provider configured under `rag.embedding` in `.anatoly.yml` (see the [Embedding Providers guide](../03-Guides/03-Embedding-Providers.md)).

### `lite`

In-process ONNX inference via `@xenova/transformers`. No external services required.

| Role | Model | Dim |
|---|---|---|
| Code | `jinaai/jina-embeddings-v2-base-code` | 768 |
| NLP | `Xenova/all-MiniLM-L6-v2` | 384 |

Models are pre-downloaded by `scripts/download-model.js` at install time. Selected automatically when no NVIDIA GPU is detected or Docker is unavailable.

### `advanced-gguf`

GPU-accelerated GGUF quantised models served by `ghcr.io/ggml-org/llama.cpp:server-cuda` Docker containers managed by `src/rag/docker-gguf.ts`. Two containers are started in sequential (swap) mode to stay within VRAM limits.

| Role | Model file | Port | Dim |
|---|---|---|---|
| Code | `nomic-embed-code.Q5_K_M.gguf` | 11437 | 3584 |
| NLP | `Qwen3-Embedding-8B-Q5_K_M.gguf` | 11438 | 4096 |

Minimum VRAM: **12 GB** (`GGUF_MIN_VRAM_GB`). Selected automatically when an NVIDIA GPU, Docker, and the NVIDIA Container Toolkit are all present.

### `advanced-fp16` (A/B test only)

Full-precision fp16 served by `ghcr.io/huggingface/text-embeddings-inference:1.9` via `src/rag/docker-tei.ts`. Used exclusively during `--ab-test` runs as the quality reference; the GGUF backend is preferred at runtime.

| Role | Port |
|---|---|
| Code | 11435 |
| NLP | 11436 |

### `external`

Routes embeddings to a third-party HTTPS API via the Vercel AI SDK. No local GPU or Docker required. Selected automatically when `rag.embedding` is set in `.anatoly.yml` (or written there by the first-run wizard's "External" tier choice).

The provider list, default models, env var conventions, and configuration shape are documented in the [Embedding Providers guide](../03-Guides/03-Embedding-Providers.md). Supported registry providers (v1): `openai`, `voyage`, `openrouter`, `cohere`, `mistral`. Custom OpenAI-compatible endpoints (Azure OpenAI, self-hosted TEI/llama.cpp clusters, HF Inference Endpoints) are supported via free-form `provider` + `base_url` + `env_key`.

The factory `getVercelEmbeddingModel(kind, modelId, config)` in [src/rag/sdk-embedding.ts](../../src/rag/sdk-embedding.ts) instantiates the SDK model, applies the registry's `max_per_call` / `supports_parallel` constraints, and runs the optional `pre_hook` (used by `anatoly-local` to hot-swap the active GGUF Docker container). Dimensions for non-registry models are probed once at boot and cached in `embeddings-ready.json` under `dim_code` / `dim_nlp` keyed by `embedding_signature`.

---

## Hardware Detection API

**`src/rag/hardware-detect.ts`**

### `detectHardware(): HardwareProfile`

Probes the local system and returns a snapshot of relevant capabilities.

```typescript
interface HardwareProfile {
  totalMemoryGB: number;
  cpuCores: number;
  hasGpu: boolean;
  gpuType?: 'nvidia' | 'apple' | 'amd';
  vramGB?: number;
  hasDocker?: boolean;
  hasNvidiaContainerToolkit?: boolean;
}
```

### `resolveEmbeddingModels(config, hardware, onLog?, readyFlag?): Promise<ResolvedModels>`

Selects concrete model IDs, runtimes, and provider routing based on the YAML config, hardware, and optional pre-existing flag. Reads `config.rag.embedding.code` / `config.rag.embedding.nlp` (split-by-axis) for the `external` and `advanced-gguf` backends.

```typescript
interface ResolvedModels {
  codeModel: string;
  codeDim: number;
  codeRuntime: 'onnx' | 'gguf' | 'sdk';
  nlpModel: string;
  nlpDim: number;
  nlpRuntime: 'onnx' | 'gguf' | 'sdk';
  backend: EmbeddingBackend;
  /** Provider identifier for code embeddings (set when runtime is 'sdk'). */
  codeProvider?: string;
  /** Resolved code endpoint base URL (absent for native SDK providers like openai). */
  codeBaseUrl?: string;
  /** Env var name holding the code provider API key (null if no key required, e.g. anatoly-local). */
  codeEnvKey?: string | null;
  nlpProvider?: string;
  nlpBaseUrl?: string;
  nlpEnvKey?: string | null;
}
```

The `'gguf'` runtime label is preserved for telemetry but resolves to the same SDK code path as `'sdk'` (the legacy native HTTP fetch was removed in Epic 50).

### `readEmbeddingsReadyFlag(projectRoot: string): EmbeddingsReadyFlag | null`

Reads `.anatoly/embeddings-ready.json`. Returns `null` if the file does not exist or is unparseable.

### `EmbeddingsReadyFlag`

Persisted configuration written after a successful `setup-embeddings` run.

```typescript
interface EmbeddingsReadyFlag {
  model?: string;           // deprecated single-model field
  dim?: number;             // deprecated
  code_model?: string;
  nlp_model?: string;
  dim_code?: number;
  dim_nlp?: number;
  device: string;
  setup_at?: string;
  checked_at?: string;
  backend?: EmbeddingBackend;
  vram_gb?: number;
  gguf_code_model?: string;
  gguf_nlp_model?: string;
  docker_image?: string;
  ab_test_at?: string;
  code_precision?: string;
  nlp_precision?: string;
  /** Provider identifier when `backend === 'external'` (e.g. 'openai', 'voyage'). */
  embedding_provider?: string;
  /** SHA-256 of {provider, code_model, nlp_model}; cache key for the runtime dim probe. */
  embedding_signature?: string;
}
```

---

## Embedding Functions

**`src/rag/embeddings.ts`**

### `configureModels(resolved: ResolvedModels): void`

Applies a `ResolvedModels` snapshot as the active runtime configuration. Must be called before the first `embedCode` / `embedNlp` invocation when overriding defaults.

### `embedCode(text: string): Promise<number[]>`

Returns a code embedding vector for the given text. Uses the code model determined at setup time. Truncates input to `MAX_CODE_CHARS = 1500` characters before embedding. In `sdk` runtime, the call is delegated to `embed()` from the Vercel AI SDK; in `onnx` runtime it runs in-process via `@huggingface/transformers`.

### `embedNlp(text: string): Promise<number[]>`

Returns an NLP embedding vector. Uses the NLP model determined at setup time. Same routing as `embedCode`.

### `embedCodeBatch(texts: string[]): Promise<number[][]>`

Batches multiple code embedding requests. In `sdk` runtime, the SDK `embedMany()` handles automatic chunking based on the registry's `max_per_call` (16 for `anatoly-local`, 2048 for external providers by default).

### `embedNlpBatch(texts: string[]): Promise<number[][]>`

Batches multiple NLP embedding requests with the same routing behaviour.

### `buildEmbedCode(name: string, signature: string, sourceBody: string): string`

Constructs the canonical input string for code embedding. Combines function name, signature, and body into the format expected by the code model.

### `buildEmbedNlp(name: string, summary: string, keyConcepts: string[], behavioralProfile: string): string`

Constructs the canonical input string for NLP embedding from LLM-generated metadata.

### Model accessors

```typescript
getCodeModelId(): string   // active code model ID
getNlpModelId(): string    // active NLP model ID
getCodeDim(): number       // active code embedding dimension
getNlpDim(): number        // active NLP embedding dimension
```

> **Note:** `embed()`, `EMBEDDING_DIM`, and `EMBEDDING_MODEL` are deprecated single-model aliases retained for backward compatibility.

---

## Docker Container Management

### GGUF containers — `src/rag/docker-gguf.ts`

```typescript
startGgufContainers(projectRoot: string, onLog?, onProgress?): Promise<boolean>
stopGgufContainers(onLog?): Promise<void>
areGgufContainersRunning(): boolean
ensureModel(model: 'code' | 'nlp'): Promise<void>   // swaps active model
```

Containers are prefixed `anatoly-gguf`. `startGgufContainers` waits up to **3 minutes** (`READY_TIMEOUT_MS = 180_000`) for the `/health` endpoint before returning. Zombie containers from previous runs are cleaned up automatically.

### TEI containers — `src/rag/docker-tei.ts`

```typescript
startTeiContainers(codeModel: string, nlpModel: string, onLog?, onProgress?): Promise<boolean>
stopTeiContainers(onLog?): Promise<void>
areTeiContainersRunning(): boolean
```

TEI containers wait up to **5 minutes** (`READY_TIMEOUT_MS = 300_000`). Used only during `--ab-test`; the GGUF backend is used at normal index time.

---

## Vector Store

**`src/rag/vector-store.ts`**

`VectorStore` wraps a LanceDB database stored at `.anatoly/rag/lancedb`. Each row holds the function card metadata plus separate `vector` (code) and `nlp_vector` (NLP) columns.

```typescript
import { VectorStore } from '@r-via/anatoly'

const store = new VectorStore('/path/to/project', 'functions')
await store.init()

const results = await store.search(queryEmbedding, 8, 0.75)
```

Distance metric: **L2**, converted to cosine similarity via `1 - L2² / 2`.

| Method | Description |
|---|---|
| `upsert(cards, embeddings, options?)` | Insert or update function cards with code (and optionally NLP) embeddings |
| `search(queryEmbedding, limit?, minScore?)` | ANN search over code vectors |
| `searchByNlpVector(queryEmbedding, limit?, minScore?)` | ANN search over NLP vectors |
| `searchByIdHybrid(functionId, codeWeight?, limit?, minScore?)` | Hybrid code+NLP search from a known function ID |
| `searchDocSections(queryEmbedding, limit?, minScore?)` | Search documentation section vectors |
| `stats()` | Return `RagStats` (card count, file count, dual-embedding flag, dimensions) |
| `rebuild()` | Drop and recreate the LanceDB table |
| `deleteByFile(filePath)` | Remove all cards belonging to a file |
| `listAll()` | Return all stored `FunctionCard` records |

---

## Examples

### Check setup status

```bash
anatoly setup-embeddings --check
```

### Run setup (hardware auto-detection)

```bash
anatoly setup-embeddings
```

### Programmatic backend resolution

```typescript
import {
  detectHardware,
  readEmbeddingsReadyFlag,
  resolveEmbeddingModels,
  configureModels,
  embedCode,
  embedNlp,
} from '@r-via/anatoly'

const projectRoot = process.cwd()
const hardware = detectHardware()
const flag = readEmbeddingsReadyFlag(projectRoot)

const resolved = await resolveEmbeddingModels(
  { code_model: undefined, nlp_model: undefined },
  hardware,
  (msg) => console.log(msg),
  flag,
)

configureModels(resolved)

console.log(`Backend: ${resolved.backend}`)
console.log(`Code model: ${resolved.codeModel} (dim=${resolved.codeDim})`)
console.log(`NLP  model: ${resolved.nlpModel} (dim=${resolved.nlpDim})`)

const codeVec = await embedCode('function add(a: number, b: number): number { return a + b }')
const nlpVec  = await embedNlp('adds two numbers and returns the result')

console.log(`Code vector length: ${codeVec.length}`)  // 768 (lite) or 3584 (gguf)
console.log(`NLP  vector length: ${nlpVec.length}`)   // 384 (lite) or 4096 (gguf)
```

### Manual GGUF container lifecycle

```typescript
import { startGgufContainers, stopGgufContainers, areGgufContainersRunning } from '@r-via/anatoly'

const started = await startGgufContainers('/path/to/project', console.log)
if (!started) {
  throw new Error('GGUF containers failed to start')
}

console.log('Running:', areGgufContainersRunning())  // true

await stopGgufContainers(console.log)
```

### Vector store search

```typescript
import { VectorStore, embedCode } from '@r-via/anatoly'

const store = new VectorStore('/path/to/project')
await store.init()

const queryVec = await embedCode('parse JSON configuration file')
const results = await store.search(queryVec, 5, 0.70)

for (const { card, score } of results) {
  console.log(`${card.name} (${card.filePath}) — score: ${score.toFixed(3)}`)
}
```

---

## See Also

- [RAG Index](./rag-index.md) — How functions are extracted, summarised, and written to the vector store
- [Vector Store](./vector-store.md) — Full `VectorStore` API reference
- [Hardware Detection](./hardware-detect.md) — `HardwareProfile`, `EmbeddingBackend`, and model registry
- [Doc Indexer](./doc-indexer.md) — Indexing Markdown documentation sections alongside code
- [NLP Summarizer](./nlp-summarizer.md) — LLM-based function summarisation pipeline
