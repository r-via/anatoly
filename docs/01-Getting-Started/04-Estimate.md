# Estimate

Before launching a full `anatoly run`, you almost always want to know two things: **how much will this cost** and **how long will it take**. The `estimate` command answers both without making a single LLM call.

```bash
anatoly estimate
```

Token counts come from a local `tiktoken` pass over the scanned files, prices are read from an on-disk cache (litellm + OpenRouter), and the wall-clock estimate uses calibrated medians from your previous runs. If no prior scan exists, `estimate` runs one automatically.

## When to use it

- **Before your first run** on a new repository — to size the operation and pick the right billing mode.
- **Before wiring it into CI** — `anatoly estimate --json` emits a stable, versioned payload you can budget against.
- **After tweaking config** — concurrency, RAG mode, triage thresholds, or model overrides all change the forecast.
- **As a sanity check** — if `total billed` shows an unexpected number, your provider mode or model resolution is misconfigured.

## Reading the output

The rendered view is built bottom-up so the verdict (Forecast) lands closest to the prompt:

```
  Project Info
  ──────────────
  name         @r-via/anatoly
  version      0.9.5
  languages    TypeScript 97% · JSON 2% · Shell 2%
  frameworks   Commander · Vitest

  Configuration
  ──────────────
  concurrency   8 files · 24 Claude slots
  cache         on
  rag           advanced — 166 files · 888 fns · 2897 chunks
  docs          0 changed, 34 cached · project 21 changed

  Cost breakdown based on latest public provider price
  ──────────────
  category       step               cost   mode           model
  axis           best_practices   $53.46   subscription   anthropic/claude-sonnet-4-6
                 correction       $27.34   subscription   anthropic/claude-sonnet-4-6
                 ...
  deliberation                    ~$3.54   subscription   anthropic/claude-opus-4-6
  summary                          $1.06   subscription   anthropic/claude-haiku-4-5
  embed          code              $0.00   local          nomic-embed-code Q5_K_M (local)
                 text              $0.00   local          Qwen3-8B Q5_K_M (local)

  total billed                     $0.00
  consumption                   ~$122.41

  Forecast
  ──────────────
  files    185 of 190  (5 skipped by triage)
  tokens   ~11.1M in / ~7.1M out + ~418K embed
  cost     $0 in subscription mode  (ensure quota for ~$122.41)
  time     ~1h 19m  (calibrated)
```

**Project Info** — name, version, detected languages, frameworks.

**Configuration** — runtime settings and indexing scope. The `rag` line carries the mode and indexing breadth; the `docs` line shows how many internal docs are changed vs cached and how many project files changed since the last run.

**Cost breakdown** — one row per pipeline step that hits the LLM (or embedding API), grouped by category (`axis` → `deliberation` → `summary` → `embed` → `internal-doc`). The `mode` column is the key one to read:

- `subscription` — covered by your Claude Code OAuth quota; you don't pay this directly.
- `api` — real per-token billing.
- `local` — free local runtime (e.g. local embedding models).

Two totals close the table:

- `total billed` — what actually leaves your wallet (sum of `api`-mode rows).
- `consumption` — the API-equivalent magnitude across all rows. Useful to size your subscription quota.

**Forecast** — the headline. The `cost` line is mode-aware:

- `$0 in subscription mode (ensure quota for ~$X)` when fully covered by OAuth.
- `$X in consumption mode` when fully API-billed.
- `$X billed (~$Y consumption equivalent)` for mixed setups.

The `time` line is tagged `(calibrated)` once you have prior runs to learn from, otherwise `(default)`.

## JSON mode

```bash
anatoly estimate --json
```

Emits a versioned payload (`schemaVersion: 1`) to stdout, with logs redirected to stderr and the banner suppressed. The shape mirrors the rendered table one-for-one.

For the full schema and an annotated example, see [CLI Reference → estimate](../03-CLI-Reference/01-Commands.md#estimate).

## Caveats

- The `cl100k_base` tokenizer is Claude-compatible but not identical — actual costs typically fall within 10–20% of the estimate, depending on prompt caching and retry rates.
- Time estimates are best after a few real runs have populated the calibration cache; the first estimate on a fresh repo uses defaults.
- `estimate` reads the same config as `run`, so make sure `--config` (or the implicit `.anatoly.yml`) points to the file you actually intend to use.
