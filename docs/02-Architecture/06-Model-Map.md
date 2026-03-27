# Model Map

Complete reference of every model used across Anatoly's pipelines, their role, and execution mode.

## Review Pipeline

| Phase | Axe | Modele par defaut | Valeurs | Mode |
|-------|-----|-------------------|---------|------|
| 1 - Scanning | Utility | `claude-haiku-4-5` | USED / DEAD / LOW_VALUE | Single-turn |
| 1 - Scanning | Duplication | `claude-haiku-4-5` | UNIQUE / DUPLICATE | Single-turn |
| 1 - Scanning | Overengineering | `claude-sonnet-4-6` | LEAN / OVER / ACCEPTABLE | Single-turn |
| 2 - Deep Review | Correction | `claude-sonnet-4-6` | OK / NEEDS_FIX / ERROR | Single-turn (2 passes) |
| 2 - Deep Review | Tests | `claude-sonnet-4-6` | GOOD / WEAK / NONE | Single-turn |
| 2 - Deep Review | Best Practices | `claude-sonnet-4-6` | Score 0-10 (17 rules) | Single-turn |
| 2 - Deep Review | Documentation | `claude-sonnet-4-6` | DOCUMENTED / PARTIAL / UNDOCUMENTED | Single-turn |
| 3 - Reconciliation | Deliberation | `claude-opus-4-6` | Reclassifies borderline findings | Single-turn |

### Model Resolution

Axis models are resolved via `resolveAxisModel()`:

1. `config.llm.axes.<axis>.model` override (if set)
2. If the evaluator's `defaultModel === 'haiku'` → `config.llm.fast_model` ?? `config.llm.index_model`
3. Otherwise → `config.llm.model` (default: `claude-sonnet-4-6`)

Deliberation model: `config.llm.deliberation_model` (default: `claude-opus-4-6`).

## Documentation Pipeline

| Etape | Modele | Mode |
|-------|--------|------|
| Doc Generation | `claude-sonnet-4-6` | **Agent** (file read, grep tools) when `agentic_tools: true` |
| Doc Coherence Review | `claude-sonnet-4-6` | Single-turn |
| Doc Content Review | `claude-opus-4-6` | Single-turn |
| Doc Update (Gap Filler) | `claude-sonnet-4-6` | Single-turn |

Doc generation is the only stage that uses agent mode with tools. All other stages are pure single-turn prompts.

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
| NLP Summarization (docs) | `claude-haiku-4-5` | Single-turn |

Doc chunking no longer uses an LLM. The `smartChunkDoc()` programmatic chunker splits on H2/H3 heading hierarchy with paragraph-level splitting for large sections, producing chunk distributions comparable to the former Haiku semantic chunker (benchmarked at ~300 chars avg embedText, <1% oversized sections).

## Summary by Model

| Modele | Role |
|--------|------|
| **Claude Haiku 4.5** | Fast/lightweight tasks: utility, duplication, summarization |
| **Claude Sonnet 4.6** | Deep evaluations: correction, tests, best practices, docs, overengineering, doc generation |
| **Claude Opus 4.6** | Highest quality: deliberation (reconciliation), doc content review |
| **Jina v2 / MiniLM** | Local ONNX embeddings (lite backend, CPU) |
| **Nomic Embed Code / Qwen3 8B** | Local GGUF embeddings (advanced backend, Docker GPU) |

## Config Defaults

```yaml
llm:
  model: claude-sonnet-4-6           # Primary model (sonnet-defaulting axes)
  index_model: claude-haiku-4-5      # Fallback for haiku-defaulting axes
  fast_model: ~                      # Optional override for haiku axes
  deliberation_model: claude-opus-4-6
  agentic_tools: true                # Doc generation uses tools
  max_stop_iterations: 3             # Max agentic iterations

rag:
  code_model: auto                   # 'auto' = detect hardware
  nlp_model: auto
  code_weight: 0.6                   # 60% code / 40% NLP in hybrid search
```
