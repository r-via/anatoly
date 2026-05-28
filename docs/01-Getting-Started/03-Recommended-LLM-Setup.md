# Recommended LLM Setup

After running `anatoly init`, your `.anatoly.yml` contains four model tiers and optional per-axis overrides. This guide helps you pick the right models for your budget and quality needs.

## Model tiers

Anatoly routes work to four model tiers. Each tier has a different cost/quality trade-off.

| Tier | Config key | Used by | Default |
|------|-----------|---------|---------|
| **Quality** | `models.quality` | correction, overengineering, tests, best_practices, documentation | `anthropic/claude-sonnet-4-6` |
| **Fast** | `models.fast` | utility, duplication, RAG summarization | `anthropic/claude-haiku-4-5` |
| **Deliberation** | `models.deliberation` | Post-review reconciliation, tier-3 investigation | `anthropic/claude-opus-4-6` |
| **Code Summary** | `models.code_summary` | RAG indexing (optional, defaults to `models.fast`) | *(none)* |

## Recommended models per tier

### Quality

Deep evaluation: axes that require reasoning, judgment, and high-confidence findings.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-sonnet-4-6` | Anthropic | **Default.** Best balance of cost and quality. |

### Fast

Lightweight, mechanical checks: pattern matching against pre-computed data.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-haiku-4-5` | Anthropic | **Default.** Fast and cheap. |

### Deliberation

Highest-quality pass: reconciliation, false-positive filtering, inter-axis contradiction resolution.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-opus-4-6` | Anthropic | **Default.** Highest reasoning quality. |
| `anthropic/claude-sonnet-4-6` | Anthropic | Budget fallback. Lower accuracy on edge cases. |

### Code Summary

RAG indexing: summarization of code for the embedding pipeline. Optional; defaults to `models.fast` if not set.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-haiku-4-5` | Anthropic | Recommended. Fast and cheap for summarization. |

## Per-axis model overrides

Each axis defaults to either the **quality** or **fast** tier. You can override any axis individually to save cost or boost accuracy.

| Axis | Default tier | What it does |
|------|-------------|--------------|
| `utility` | fast | Pattern matching on pre-computed usage graph |
| `duplication` | fast | Semantic comparison of RAG candidates |
| `correction` | quality | Bug/logic error detection (95%+ confidence required) |
| `overengineering` | quality | Structural complexity analysis |
| `tests` | quality | Coverage quality assessment |
| `best_practices` | quality | 17 framework-aware coding rules |
| `documentation` | quality | JSDoc and concept coverage evaluation |

Override syntax:

```yaml
axes:
  correction:
    enabled: true
    model: anthropic/claude-opus-4-6   # upgrade for max bug-detection accuracy
  utility:
    enabled: true
    model: anthropic/claude-haiku-4-5  # downgrade to cheapest for mechanical checks
```

## Example configurations

### Anthropic-only (subscription)

Best quality with Claude models across the board. Ideal if you have a Max subscription.

```yaml
providers:
  anthropic:
    mode: subscription
    concurrency: 24

models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5
  deliberation: anthropic/claude-opus-4-6
```

### Max quality

Upgrade critical axes to Opus, use Sonnet elsewhere.

```yaml
providers:
  anthropic:
    mode: subscription
    concurrency: 24

models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5
  deliberation: anthropic/claude-opus-4-6

axes:
  correction:
    enabled: true
    model: anthropic/claude-opus-4-6      # max accuracy on bug detection
  best_practices:
    enabled: true
    model: anthropic/claude-opus-4-6      # strictest rule enforcement
  utility:
    enabled: true
    model: anthropic/claude-haiku-4-5     # cheapest for mechanical checks
  duplication:
    enabled: true
    model: anthropic/claude-haiku-4-5
```

## How model resolution works

When Anatoly evaluates an axis, the model is resolved in this order:

1. **Per-axis override**: `axes.<axis>.model` (highest priority)
2. **Tier mapping**: if the axis defaults to `haiku` → `models.fast`; if `sonnet` → `models.quality`
3. **Provider routing**: the `provider/model` prefix determines which provider handles the call

The deliberation model is always read from `models.deliberation` and only runs when `--deliberation` is enabled.
