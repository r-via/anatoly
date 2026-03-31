# Model Map

Complete reference of every model used across Anatoly's pipelines, their role, execution mode, and transport backend.

## Review Pipeline

| Axis | Default model | Verdicts | Task type | Transport |
|------|---------------|----------|-----------|-----------|
| Utility | `config.models.fast` | USED / DEAD / LOW_VALUE | Single-turn | Per provider mode |
| Duplication | `config.models.fast` | UNIQUE / DUPLICATE | Single-turn | Per provider mode |
| Overengineering | `config.models.fast` | LEAN / OVER / ACCEPTABLE | Single-turn | Per provider mode |
| Correction | `config.models.quality` | OK / NEEDS_FIX / ERROR | Single-turn | Per provider mode |
| Tests | `config.models.quality` | GOOD / WEAK / NONE | Single-turn | Per provider mode |
| Best Practices | `config.models.quality` | Score 0-10 (17 rules) | Single-turn | Per provider mode |
| Documentation | `config.models.quality` | DOCUMENTED / PARTIAL / UNDOCUMENTED | Single-turn | Per provider mode |

Transport is resolved by the `TransportRouter` based on the model's provider and configured mode. See [Transport Architecture](./08-Transport-Architecture.md) for the full dispatch matrix.

### Model Resolution

Axis models are resolved via `resolveAxisModel()`:

1. `config.axes.<axis>.model` override (if set and provider is configured)
2. If the evaluator's `defaultModel === 'haiku'` → `config.models.fast`
3. Otherwise → `config.models.quality` (default: `anthropic/claude-sonnet-4-6`)

Deliberation model: `config.models.deliberation` (default: `anthropic/claude-opus-4-6`).

## Refinement Pipeline

| Tier | Model | Task type | Tools | Transport |
|------|-------|-----------|-------|-----------|
| Tier 1 — Auto-resolve | *none (deterministic)* | — | — | — |
| Tier 2 — Coherence | *none (deterministic)* | — | — | — |
| Tier 3 — Investigation | `config.models.deliberation` | **Agentic** | Read, Grep, Glob, Bash, WebFetch | `router.agenticQuery()` |

Max turns for tier 3: `config.agents.max_turns` (default: 30).

## Documentation Pipeline

| Stage | Model | Task type | Transport |
|-------|-------|-----------|-----------|
| Doc Generation | `config.models.quality` | **Agentic** (Read tool) | `router.agenticQuery()` |
| Doc Coherence Review | `config.models.quality` | Single-turn | Per provider mode |
| Doc Content Review | `config.models.deliberation` | Single-turn | Per provider mode |
| Doc Update (Gap Filler) | `config.models.quality` | Single-turn | Per provider mode |

## RAG / Embeddings Pipeline

Anatoly supports two embedding backends, auto-selected based on hardware.

### Lite Backend (ONNX, CPU)

Default when no GPU is available or GGUF backend is not configured.

| Role | Modele | Dimensions | Runtime |
|------|--------|------------|---------|
| Code embeddings | `jinaai/jina-embeddings-v2-base-code` | 768 | ONNX (in-process) |
| NLP embeddings | `Xenova/all-MiniLM-L6-v2` | 384 | ONNX (in-process) |

### Advanced-GGUF Backend (Docker GPU)

Requires `setup-embeddings`, Docker, NVIDIA Container Toolkit, and 12 GB+ VRAM.

| Role | Modele | Dimensions | Runtime |
|------|--------|------------|---------|
| Code embeddings | `nomic-ai/nomic-embed-code` (Q5_K_M) | 3584 | llama.cpp Docker (CUDA) |
| NLP embeddings | `Qwen/Qwen3-Embedding-8B` (Q5_K_M) | 4096 | llama.cpp Docker (CUDA) |

### LLM-Assisted RAG Steps

| Etape | Modele | Mode |
|-------|--------|------|
| Doc Chunking | _none_ (programmatic) | Smart H2+H3+paragraph splitter |
| NLP Summarization (docs) | `config.models.fast` | Single-turn |

Doc chunking no longer uses an LLM. The `smartChunkDoc()` programmatic chunker splits on H2/H3 heading hierarchy with paragraph-level splitting for large sections, producing chunk distributions comparable to the former Haiku semantic chunker (benchmarked at ~300 chars avg embedText, <1% oversized sections).

## Summary by Model

| Model | Config key | Role |
|-------|-----------|------|
| `anthropic/claude-haiku-4-5` | `models.fast` | Fast tasks: utility, duplication, overengineering, NLP summarization |
| `anthropic/claude-sonnet-4-6` | `models.quality` | Deep evaluations: correction, tests, best practices, documentation, doc generation |
| `anthropic/claude-opus-4-6` | `models.deliberation` | Tier 3 investigation, doc content review |
| Jina v2 / MiniLM | `rag.code_model` / `rag.nlp_model` | Local ONNX embeddings (lite backend, CPU) |
| Nomic Embed Code / Qwen3 8B | `rag.code_model` / `rag.nlp_model` | Local GGUF embeddings (advanced backend, Docker GPU) |

## Config Defaults (v2 format)

```yaml
providers:
  anthropic:
    mode: subscription
    concurrency: 24
  google:
    mode: api
    concurrency: 10

models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5
  deliberation: anthropic/claude-opus-4-6

agents:
  enabled: true
  max_turns: 30                      # Max agentic turns (tier 3, doc generation)

rag:
  code_model: auto                   # 'auto' = detect hardware
  nlp_model: auto
  code_weight: 0.6                   # 60% code / 40% NLP in hybrid search
```

See [Transport Architecture](./08-Transport-Architecture.md) for how models are routed to backends.
