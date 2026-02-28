# Configuration

Create a `.anatoly.yml` at the project root (optional — sensible defaults apply):

```yaml
project:
  name: "my-ts-project"
  monorepo: true

scan:
  include:
    - "src/**/*.ts"
    - "src/**/*.tsx"
  exclude:
    - "node_modules/**"
    - "dist/**"
    - "**/*.test.ts"
    - "**/*.spec.ts"

coverage:
  enabled: true
  command: "npx vitest run --coverage.reporter=json"
  report_path: "coverage/coverage-final.json"

llm:
  model: "claude-sonnet-4-6"
  index_model: "claude-haiku-4-5-20251001" # model for RAG card generation
  fast_model: "claude-haiku-4-5-20251001"  # optional: cheaper model for fast-tier reviews
  agentic_tools: true
  timeout_per_file: 600
  max_retries: 3
  concurrency: 4            # parallel reviews (1-10, or use --concurrency flag)
  min_confidence: 70         # minimum confidence to report findings (hook mode)
  max_stop_iterations: 3     # anti-loop limit for stop hook
  deliberation: true         # enable Opus deliberation pass (default: false)
  deliberation_model: "claude-opus-4-6"  # model for deliberation (default: claude-opus-4-6)

rag:
  enabled: true              # disable with --no-rag or set to false
  dual_embedding: false      # enable dual code+NLP embedding (default: false)
  code_model: auto           # code embedding model ('auto' = hardware-based, or HuggingFace ID)
  nlp_model: auto            # NLP embedding model ('auto' = all-MiniLM-L6-v2, or HuggingFace ID)
  code_weight: 0.6           # hybrid search: code similarity weight (NLP = 1 - code_weight)

output:
  max_runs: 10      # optional: purge old runs beyond this limit
```

## Global CLI Flags

```
--config <path>      Path to .anatoly.yml config file
--verbose            Enable verbose output (per-file time, cost, retries)
--no-cache           Skip cache, re-review all files
--file <glob>        Target specific files (e.g. "src/utils/**/*.ts")
--plain              Disable spinners and colors
--no-color           Disable colors only (also respects $NO_COLOR env var)
--open               Open report in default app after generation
--concurrency <n>    Number of concurrent reviews, 1-10 (default: 4)
--no-rag             Disable semantic RAG cross-file analysis
--rebuild-rag        Force full RAG re-indexation
--dual-embedding     Enable dual code+NLP embedding for RAG
--no-dual-embedding  Disable dual embedding (code-only, overrides config)
--code-model <model> Embedding model for code vectors (default: auto-detect)
--nlp-model <model>  Embedding model for NLP vectors (default: auto-detect)
--no-triage          Disable triage, review all files with full agent
--deliberation       Enable Opus deliberation pass after axis merge
--no-deliberation    Disable deliberation pass (overrides config)
--no-badge           Skip README badge injection after audit
--badge-verdict      Include audit verdict in README badge
--log-level <level>  Set log level (fatal, error, warn, info, debug, trace)
--log-file <path>    Write logs to file in ndjson format
```

## Review Output

Each reviewed file produces two outputs:

**`.rev.json`** — Machine-readable, Zod-validated:

| Axis | Values |
|------|--------|
| `correction` | `OK` / `NEEDS_FIX` / `ERROR` |
| `overengineering` | `LEAN` / `OVER` / `ACCEPTABLE` |
| `utility` | `USED` / `DEAD` / `LOW_VALUE` |
| `duplication` | `UNIQUE` / `DUPLICATE` |
| `tests` | `GOOD` / `WEAK` / `NONE` |
| `best_practices` | Score 0–10 (17 rules) + suggestions |
| `confidence` | 0–100 |

**`report.md`** — Sharded audit report:
- `report.md` — compact index (~100 lines) with executive summary, severity table, checkbox links to shards, and triage stats
- `report.N.md` — per-shard detail files (max 10 files each), sorted by severity with Quick Wins / Refactors / Hygiene actions
