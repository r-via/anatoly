# Recommended LLM Setup

After `anatoly init`, your `.anatoly.yml` (schema `version: 3`) declares the providers you can reach, routes generation work to four slots, sets the reasoning effort per slot, and lets you override the model per axis. This guide helps you pick the right models and effort for your budget and quality needs.

## Generation slots

Anatoly routes every LLM call to one of four slots under `routing.generation`. Each slot has a different cost/quality trade-off.

| Slot | Config key | Used by | Default (since 0.11.0) |
|------|-----------|---------|------------------------|
| **Quality** | `routing.generation.quality` | correction, overengineering, tests, best_practices, documentation | `anthropic/claude-sonnet-5-5` |
| **Fast** | `routing.generation.fast` | utility, duplication | `anthropic/claude-haiku-5-5` |
| **Deliberation** | `routing.generation.deliberation` | Tier-3 investigation of disputed findings, internal doc generation (agentic) | `anthropic/claude-opus-5-5` |
| **Summarization** | `routing.generation.summarization` | RAG code summaries and doc chunk summaries | `anthropic/claude-haiku-5-5` |

A model reference is `provider/model`. The provider must be declared under `providers`, and the model must appear in that provider's `models` list.

## Reasoning effort

Since 0.11.0 every Claude call carries an explicit reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`), `high` on every slot by default. Without it, the Claude Code CLI picks the effort itself and chooses `medium` for the 5.5 generation: on the slot-engine benchmark that single difference costs about 12 F1 points (61.4% against 73.2% on the same code and prompts).

Override per slot under `routing.effort`; omitted slots keep `high`:

```yaml
routing:
  effort:
    quality: high
    fast: high
    deliberation: high
    summarization: high
```

Lower effort is cheaper and faster but costs findings. Only `medium` against `high` has been measured, on the quality slot; a lower effort on `fast` or `summarization` has not been benchmarked. On the previous generation the CLI applies its own limits: it drops the effort on Haiku 4.5 and clamps `xhigh` to `high` on Sonnet 4.6.

## Recommended models per slot

### Quality

Deep evaluation: axes that require reasoning, judgment, and high-confidence findings.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-sonnet-5-5` | Anthropic | **Default.** Best balance of cost and quality. On slot-engine: 69.9% and 75.1% F1 (v65, v66) at about $1.50 to $2 per run. |
| `anthropic/claude-sonnet-4-6` | Anthropic | Previous generation, still supported. Same F1 band (68.6% to 76.8%) at 2 to 2.5 times the cost and twice the wall time. |

### Fast

Lightweight, mechanical checks: pattern matching against pre-computed data.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-haiku-5-5` | Anthropic | **Default.** Fast and cheap. |

### Deliberation

Highest-quality pass: reconciliation, false-positive filtering, inter-axis contradiction resolution. This slot must point to an agentic transport (`claude_agent_sdk`).

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-opus-5-5` | Anthropic | **Default.** Highest reasoning quality. |
| `anthropic/claude-sonnet-5-5` | Anthropic | Budget fallback. Lower accuracy on edge cases. |

### Summarization

RAG indexing: summaries of code and documentation chunks for the embedding pipeline. The summaries are cached in `.anatoly/cache/rag/` and reused across runs; the cache is not keyed by model, so run `anatoly reset` after changing this slot if you want fresh summaries.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-haiku-5-5` | Anthropic | **Default.** Fast and cheap for summarization. |

## Per-axis model overrides

Each axis defaults to either the **quality** or the **fast** slot. You can override any axis individually to save cost or boost accuracy.

| Axis | Default slot | What it does |
|------|-------------|--------------|
| `utility` | fast | Pattern matching on pre-computed usage graph |
| `duplication` | fast | Semantic comparison of RAG candidates |
| `correction` | quality | Bug/logic error detection (95%+ confidence required) |
| `overengineering` | quality | Structural complexity analysis |
| `tests` | quality | Coverage quality assessment |
| `best_practices` | quality | 17 framework-aware coding rules |
| `documentation` | quality | JSDoc and concept coverage evaluation |

An axis entry is either a boolean or an object; `model` replaces the slot for that axis:

```yaml
evaluation:
  axes:
    correction:
      enabled: true
      model: anthropic/claude-opus-5-5   # upgrade for max bug-detection accuracy
    utility: true                        # keep the fast slot
```

## Example configurations

### Anthropic-only (subscription)

Best quality with Claude models across the board, no API key: the `claude_agent_sdk` transport with `oauth` auth reuses your Claude Code login. Ideal with a Max subscription.

```yaml
providers:
  anthropic:
    transport: claude_agent_sdk
    auth: oauth
    concurrency: 24
    models:
      - claude-sonnet-5-5
      - claude-haiku-5-5
      - claude-opus-5-5

routing:
  generation:
    quality: anthropic/claude-sonnet-5-5
    fast: anthropic/claude-haiku-5-5
    deliberation: anthropic/claude-opus-5-5
    summarization: anthropic/claude-haiku-5-5
```

### Max quality

Upgrade the critical axes to Opus, keep Sonnet elsewhere.

```yaml
routing:
  generation:
    quality: anthropic/claude-sonnet-5-5
    fast: anthropic/claude-haiku-5-5
    deliberation: anthropic/claude-opus-5-5
    summarization: anthropic/claude-haiku-5-5

evaluation:
  axes:
    correction:
      enabled: true
      model: anthropic/claude-opus-5-5      # max accuracy on bug detection
    best_practices:
      enabled: true
      model: anthropic/claude-opus-5-5      # strictest rule enforcement
    utility: true
    duplication: true
```

## How model resolution works

When Anatoly evaluates an axis, the model is resolved in this order:

1. **Per-axis override**: `evaluation.axes.<axis>.model` (highest priority)
2. **Slot mapping**: the axis's default slot under `routing.generation`
3. **Provider routing**: the `provider/` prefix selects the entry under `providers`, whose `transport` and `auth` decide how the call is made

The reasoning effort follows the slot the model belongs to (`routing.effort.<slot>`); a model used by several slots gets the highest effort configured among them. The deliberation model is always read from `routing.generation.deliberation` and runs in the refinement pass on findings the axes could not settle.
