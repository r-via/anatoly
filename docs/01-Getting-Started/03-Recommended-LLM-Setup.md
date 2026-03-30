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

Deep evaluation — axes that require reasoning, judgment, and high-confidence findings.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-sonnet-4-6` | Anthropic | **Default.** Best balance of cost and quality. |
| `google/gemini-2.5-pro` | Google | Strong alternative. Generous rate limits on API plans. |
| `google/gemini-2.5-flash` | Google | Budget option. Still capable for most axes. |
| `google/gemini-3-flash-preview` | Google | Preview model. Fast, good reasoning, competitive pricing. |

### Fast

Lightweight, mechanical checks — pattern matching against pre-computed data.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-haiku-4-5` | Anthropic | **Default.** Fast and cheap. |
| `google/gemini-2.5-flash-lite` | Google | Cheapest option. Good for mechanical checks. |
| `google/gemini-2.5-flash` | Google | Slightly more capable, still fast. |

### Deliberation

Highest-quality pass — reconciliation, false-positive filtering, inter-axis contradiction resolution.

| Model | Provider | Notes |
|-------|----------|-------|
| `anthropic/claude-opus-4-6` | Anthropic | **Default.** Highest reasoning quality. |
| `google/gemini-2.5-pro` | Google | Cost-effective alternative with strong reasoning. |
| `anthropic/claude-sonnet-4-6` | Anthropic | Budget fallback. Lower accuracy on edge cases. |

### Code Summary

RAG indexing — summarization of code for the embedding pipeline. Optional; defaults to `models.fast` if not set.

| Model | Provider | Notes |
|-------|----------|-------|
| `google/gemini-2.5-flash-lite` | Google | Recommended. Fast and cheap for summarization. |
| `anthropic/claude-haiku-4-5` | Anthropic | Solid alternative. |

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
    model: google/gemini-2.5-flash-lite # downgrade to cheapest for mechanical checks
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

### Google-only (API)

All Google models. Great rate limits and competitive pricing.

```yaml
providers:
  google:
    mode: api
    concurrency: 10

models:
  quality: google/gemini-2.5-pro
  fast: google/gemini-2.5-flash-lite
  deliberation: google/gemini-2.5-pro
  code_summary: google/gemini-2.5-flash-lite
```

### Multi-provider (budget)

Mix providers to optimize cost. Use Google's cheapest models for fast/mechanical work, Anthropic for deep analysis.

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
  fast: google/gemini-2.5-flash-lite
  deliberation: anthropic/claude-opus-4-6
  code_summary: google/gemini-2.5-flash-lite
```

### Multi-provider (max quality)

Upgrade critical axes to Opus, use Sonnet elsewhere.

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

axes:
  correction:
    enabled: true
    model: anthropic/claude-opus-4-6      # max accuracy on bug detection
  best_practices:
    enabled: true
    model: anthropic/claude-opus-4-6      # strictest rule enforcement
  utility:
    enabled: true
    model: google/gemini-2.5-flash-lite   # cheapest for mechanical checks
  duplication:
    enabled: true
    model: google/gemini-2.5-flash-lite
```

### All-flash (fastest & cheapest)

Minimum cost, maximum speed. Good for quick iterative scans during development.

```yaml
providers:
  google:
    mode: api
    concurrency: 10

models:
  quality: google/gemini-2.5-flash
  fast: google/gemini-2.5-flash-lite
  deliberation: google/gemini-2.5-flash
  code_summary: google/gemini-2.5-flash-lite
```

## How model resolution works

When Anatoly evaluates an axis, the model is resolved in this order:

1. **Per-axis override** — `axes.<axis>.model` (highest priority)
2. **Tier mapping** — if the axis defaults to `haiku` → `models.fast`; if `sonnet` → `models.quality`
3. **Provider routing** — the `provider/model` prefix determines which provider handles the call

The deliberation model is always read from `models.deliberation` and only runs when `--deliberation` is enabled.
