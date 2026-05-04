# Embedding Providers

> Choose the embedding tier and (optionally) the third-party provider that powers Anatoly's semantic RAG index — from zero-config local CPU to best-of-breed cloud APIs.

## Overview

Anatoly produces two embedding vectors for every indexed function — a **code** vector (structural/syntactic semantics) and an **NLP** vector (natural-language semantics). Three execution paths are available, in increasing order of recall and operational complexity:

| Tier | Engine | Setup | Hardware | Recall | Cost | Use case |
|---|---|---|---|---|---|---|
| **`lite`** | ONNX in-process via `@huggingface/transformers` | None (auto on first run) | CPU only | Good | Free | Default. Works everywhere, no external services. |
| **`advanced`** | GGUF llama.cpp Docker container (`anatoly-local`) | Run `anatoly setup-embeddings` once | NVIDIA GPU + ≥ 12 GB VRAM + Docker | Best | Free (after model download, ~10 GB) | Local power users with a capable GPU who want maximum quality without sending code to a third party. |
| **`external`** | Vercel AI SDK → any OpenAI-compatible API (OpenAI, Voyage, Qwen, Cohere, Mistral, custom) | Set provider + API key in `.anatoly.yml` | None (CPU only) | Provider-dependent | Per-token billed by the provider | Cloud-friendly, zero local infra. Best when you have a Voyage/OpenAI account or a corporate inference endpoint. |

The active tier is selected at first run via the embedded wizard or by editing `.anatoly.yml` directly. The CLI flags `--rag-lite` and `--rag-advanced` override the persisted choice for a single run; the `external` tier requires an explicit YAML config.

The `lite` tier is unaffected by anything in this document — it runs in-process with no provider concept. The remainder of this guide covers the `external` tier, which is also the foundation under the hood for the local `advanced` tier (the GGUF Docker container is modelled internally as a provider named `anatoly-local`).

---

## Configuration shape

The provider is declared under `rag.embedding` in [`.anatoly.yml`](../03-Guides/02-Advanced-Configuration.md#rag), split per axis so you can mix providers (best-of-breed):

```yaml
rag:
  embedding:
    code:
      provider: voyage              # required
      model: voyage-code-3          # optional, registry default applies if omitted
      base_url: https://...         # optional, registry default applies for known providers
      env_key: VOYAGE_API_KEY       # optional, registry default applies for known providers
    nlp:
      provider: qwen
      model: text-embedding-v4
```

Both `code` and `nlp` sections are independently optional. If only one is set, the other duplicates it at runtime. If both are absent, Anatoly falls back to `lite` or `advanced` based on `.anatoly/embeddings-ready.json`.

The schema is `EmbeddingConfigSchema` in [src/schemas/config.ts](../../src/schemas/config.ts). Custom fields are accepted via `.passthrough()` for forward compatibility.

---

## Supported providers

The registry lives at [src/rag/known-embedding-providers.ts](../../src/rag/known-embedding-providers.ts). Each entry provides default URLs, env var names, batch constraints, and recommended models — so a YAML config containing only `provider: openai` works out of the box.

### `openai`

Native via [`@ai-sdk/openai`](https://ai-sdk.dev/providers/ai-sdk-providers/openai). The fastest path for users who already have an OpenAI account.

| Field | Value |
|---|---|
| `base_url` | `null` (native SDK) |
| `env_key` | `OPENAI_API_KEY` |
| Default code model | `text-embedding-3-large` (3072d) |
| Default NLP model | `text-embedding-3-large` (3072d) |
| Notes | `text-embedding-3-small` (1536d) is the cheaper alternative if vector store size matters. |

```yaml
rag:
  embedding:
    code: { provider: openai, model: text-embedding-3-large }
    nlp:  { provider: openai, model: text-embedding-3-large }
```

### `voyage`

[Voyage AI](https://docs.voyageai.com/) — the recommended **code retrieval** provider. `voyage-code-3` is SOTA on CoIR and CodeSearchNet benchmarks.

| Field | Value |
|---|---|
| `base_url` | `https://api.voyageai.com/v1` |
| `env_key` | `VOYAGE_API_KEY` |
| Default code model | `voyage-code-3` (1024d, Matryoshka 256/512/1024/2048) |
| Default NLP model | `voyage-3-large` (1024d) |
| Notes | Voyage is the embedding partner recommended by Anthropic. Strong on multi-language code. |

```yaml
rag:
  embedding:
    code: { provider: voyage, model: voyage-code-3 }
    nlp:  { provider: voyage, model: voyage-3-large }
```

### `qwen` (Alibaba DashScope)

Hosted Qwen3-Embedding family via DashScope international. Direct parity with the open-weights Qwen3-Embedding-8B used by the local `advanced` tier on the NLP axis.

| Field | Value |
|---|---|
| `base_url` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `env_key` | `DASHSCOPE_API_KEY` |
| Default code model | `text-embedding-v4` |
| Default NLP model | `text-embedding-v4` |
| Notes | The DashScope model ID that exposes Qwen3-Embedding-8B has not yet been validated empirically against the `text-embedding-v4` vs `qwen3-embedding-N` SKU split. Adjust `model:` if your account exposes a different ID. The runtime dim probe (cached in `.anatoly/embeddings-ready.json`) absorbs any mismatch. |

```yaml
rag:
  embedding:
    code: { provider: qwen, model: text-embedding-v4 }
    nlp:  { provider: qwen, model: text-embedding-v4 }
```

### `cohere`

[Cohere Embed v3](https://docs.cohere.com/docs/embeddings) — strong on multilingual NLP retrieval. Less specialised on code.

| Field | Value |
|---|---|
| `base_url` | `https://api.cohere.com/v1` |
| `env_key` | `COHERE_API_KEY` |
| Default code model | `embed-english-v3.0` (1024d) |
| Default NLP model | `embed-english-v3.0` (1024d) |
| Notes | Use `embed-multilingual-v3.0` for non-English codebases. |

### `mistral`

[Mistral Embed](https://docs.mistral.ai/capabilities/embeddings/) — single model, simplest setup.

| Field | Value |
|---|---|
| `base_url` | `https://api.mistral.ai/v1` |
| `env_key` | `MISTRAL_API_KEY` |
| Default code model | `mistral-embed` (1024d) |
| Default NLP model | `mistral-embed` (1024d) |

---

## Recommended combo — best-of-breed quality

For users who want the highest semantic recall **without** running a local GPU, mix Voyage for code with Qwen for NLP:

```yaml
# .anatoly.yml
rag:
  embedding:
    code:
      provider: voyage
      model: voyage-code-3
    nlp:
      provider: qwen
      model: text-embedding-v4
```

| Axis | Provider/Model | Why |
|---|---|---|
| Code | `voyage/voyage-code-3` | SOTA on CoIR for code retrieval, ~13% above OpenAI text-embedding-3-large on aggregate |
| NLP | `qwen/text-embedding-v4` | Direct hosted variant of the Qwen3-Embedding family used by the local `advanced` tier |

Required env vars: `VOYAGE_API_KEY` and `DASHSCOPE_API_KEY`.

This combo is the closest cloud-friendly equivalent to running the GGUF `advanced` tier locally — no GPU required, comparable F1 on `anatoly-bench`.

---

## Custom provider

Any OpenAI-compatible `/v1/embeddings` endpoint can be used by declaring the provider name plus `base_url` and `env_key`:

```yaml
rag:
  embedding:
    code:
      provider: my-internal-embed
      base_url: https://embed.internal.corp/v1
      env_key: INTERNAL_EMBED_KEY
      model: nomic-embed-code-v2
    nlp:
      provider: my-internal-embed
      base_url: https://embed.internal.corp/v1
      env_key: INTERNAL_EMBED_KEY
      model: gte-large-en-v1.5
```

The endpoint must:

- Accept `POST /embeddings` with body `{ model, input, encoding_format: "float" }` (input may be a string or an array).
- Return `{ data: [{ embedding: number[], index: number }], usage: { prompt_tokens: number } }` — the OpenAI-strict shape.
- The `model` field in the request body is sent verbatim; servers that ignore it (like llama.cpp) are tolerated.

Endpoints that diverge from this shape (nested `embedding[[...]]`, missing `data[]`, etc.) are **not supported**. Run them behind a thin proxy that normalises the response.

---

## Cloud Anatoly (SaaS)

The hosted SaaS version of Anatoly routes embeddings server-side to a provider chosen by Anatoly (HuggingFace Inference Endpoints, Modal, Voyage, etc. — selected for cost and quality, subject to change). The client does **not** see or configure the provider; the cloud workspace consumes an authenticated Anatoly endpoint and the embedding "just happens".

This means:
- **No `rag.embedding` configuration required** when running against `anatoly.cloud`.
- **No client-side API keys** for embeddings — billing is rolled into the SaaS subscription.
- **Provider transparency is intentional** — Anatoly may switch backends to optimise margins or recall, without changing the client experience.

If you need to know or control which provider runs your embeddings, choose the **Enterprise dedicated deployment** path below.

---

## Enterprise dedicated deployment

For organisations that require data sovereignty, a custom provider, or audit isolation, Anatoly runs as the **same CLI binary** inside the customer's VPC or private cloud, configured via `.anatoly.yml`. Three deployment patterns are supported:

### (a) Azure OpenAI internal

Route both axes to Azure-hosted OpenAI deployments. Azure exposes embeddings under `https://{resource}.openai.azure.com/openai/deployments/{deployment}/embeddings?api-version=...` — pass the full URL as `base_url`.

```yaml
rag:
  embedding:
    code:
      provider: azure-openai-internal
      base_url: https://contoso.openai.azure.com/openai/deployments/text-embedding-3-large/embeddings?api-version=2024-02-01
      env_key: AZURE_OPENAI_KEY
      model: text-embedding-3-large
    nlp:
      provider: azure-openai-internal
      base_url: https://contoso.openai.azure.com/openai/deployments/text-embedding-3-large/embeddings?api-version=2024-02-01
      env_key: AZURE_OPENAI_KEY
      model: text-embedding-3-large
```

`code` and `nlp` may point at different Azure deployments of the same resource if you want to mix model sizes.

### (b) Self-hosted GGUF cluster

If you already operate llama.cpp or TEI containers behind an internal load balancer, point Anatoly at them. The serving stack is the same one Anatoly uses locally for `advanced` — just on your infrastructure.

```yaml
rag:
  embedding:
    code:
      provider: anatoly-local-cluster
      base_url: https://embed-code.internal.corp/v1
      env_key: INTERNAL_EMBED_KEY
      model: nomic-embed-code
    nlp:
      provider: anatoly-local-cluster
      base_url: https://embed-nlp.internal.corp/v1
      env_key: INTERNAL_EMBED_KEY
      model: qwen3-embedding-8b
```

This pattern delivers the same recall as the local `advanced` tier without exposing the GPU container on the audit machine.

### (c) HuggingFace Inference Endpoints (customer account)

Deploy `Qwen/Qwen3-Embedding-8B` and `nomic-ai/nomic-embed-code` (or any other model) on dedicated HF Inference Endpoints inside your AWS/Azure account, then point Anatoly at them.

```yaml
rag:
  embedding:
    code:
      provider: hf-internal
      base_url: https://abc123-code.eu-west-1.aws.endpoints.huggingface.cloud/v1
      env_key: HF_INTERNAL_TOKEN
      model: nomic-embed-code
    nlp:
      provider: hf-internal
      base_url: https://abc123-nlp.eu-west-1.aws.endpoints.huggingface.cloud/v1
      env_key: HF_INTERNAL_TOKEN
      model: Qwen3-Embedding-8B
```

In all three patterns the customer retains full control of the data path: code chunks never leave the customer's network. Anatoly's CLI has no embedded telemetry on the embedding axis.

---

## Operational notes

### Dimension probe and signature cache

For models not in the registry (custom providers or new model IDs), Anatoly probes the dimension at boot time with a single `embed("anatoly probe")` call, then caches the result in `.anatoly/embeddings-ready.json` under `dim_code` / `dim_nlp` plus an `embedding_signature` (SHA-256 of `{provider, code_model, nlp_model}`). Subsequent runs skip the probe unless the signature changes.

### Batch limits

The Vercel AI SDK handles automatic chunking. For external providers the default batch size is 2048 (SDK default). For the local `anatoly-local` provider, the registry pins `max_per_call: 16` and `supports_parallel: false` to match the llama.cpp container's context window and the sequential code/NLP swap pattern.

### Missing API keys

If a provider's `env_key` is referenced but `process.env[env_key]` is not set, the wizard writes the YAML anyway and warns. The audit will fail at the first embedding call with a clear error: `No API key for embedding provider "X". Set {ENV_KEY} in your environment.` Export the key and re-run.

### Switching providers post-setup

Edit `rag.embedding` in `.anatoly.yml` and re-run `anatoly run`. The signature cache invalidates automatically; the dim probe runs once for the new provider and caches the result. No manual cleanup of `.anatoly/` is required unless dimensions change in a way that breaks the existing LanceDB index — in that case `anatoly clean rag-index` rebuilds it.

---

## See also

- [Setup Embeddings](../05-Modules/setup-embeddings.md) — runtime backend resolution, Docker container lifecycle, hardware detection.
- [Advanced Configuration — `rag` section](./02-Advanced-Configuration.md#rag) — full schema reference for `.anatoly.yml`.
- [Multi-Provider Migration (Epic 43)](../../_bmad-output/planning-artifacts/epic-43-multi-provider-migration.md) — sibling abstraction for LLM providers.
- Code: [src/rag/known-embedding-providers.ts](../../src/rag/known-embedding-providers.ts), [src/rag/sdk-embedding.ts](../../src/rag/sdk-embedding.ts), [src/rag/embeddings.ts](../../src/rag/embeddings.ts).
