# Installation

## Prerequisites

- **Node.js >= 20.19** -- Anatoly uses modern Node.js APIs (ES modules, native fetch). Check your version with `node --version`.
- **ANTHROPIC_API_KEY** -- Set your Anthropic API key as an environment variable. Anatoly uses the Claude Agent SDK to run its review agents.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

You can add this to your shell profile (`~/.bashrc`, `~/.zshrc`) or use a `.env` manager. Anatoly reads the key from the environment at runtime.

## Install

### Run without installing

The fastest way to try Anatoly:

```bash
npx @r-via/anatoly run
```

### Install globally (npm)

```bash
npm install -g @r-via/anatoly
anatoly run
```

### Install globally (pnpm)

```bash
pnpm add -g @r-via/anatoly
anatoly run
```

### Install as a dev dependency

```bash
npm install -D @r-via/anatoly
npx anatoly run
```

On first install, a `postinstall` script downloads the default embedding model (Jina Embeddings V2 Base Code, ONNX). This is a one-time download.

### Optional: GPU-accelerated embeddings

If you have an NVIDIA GPU with >= 12 GB VRAM and Docker installed, you can use GGUF-quantized models in Docker llama.cpp containers for higher-quality embeddings:

```bash
npx anatoly setup-embeddings        # Pulls Docker images, downloads GGUF models (SHA256-verified)
npx anatoly setup-embeddings --check # Check status without installing
npx anatoly setup-embeddings --ab-test # Validate GGUF quality against fp16 reference
```

Containers start automatically with `anatoly run` when setup is detected. No Python dependency -- Docker is the only runtime requirement for GPU mode.

## First run walkthrough

From your project root (the directory containing `package.json` and your `src/` folder):

```bash
npx anatoly run
```

This single command executes the full pipeline:

```
scan --> estimate --> triage --> usage graph --> index --> review --> deliberate --> report
```

### What happens step by step

1. **Config** -- Anatoly looks for `.anatoly.yml` in the project root. If none exists, it uses sensible defaults (scans `src/**/*.ts` and `src/**/*.tsx`).

2. **Scan** -- The AST scanner (web-tree-sitter) parses every matched file and extracts symbols: functions, classes, types, enums, hooks, constants. It records line ranges, export status, and computes SHA-256 hashes for caching.

3. **Estimate** -- A local token estimation pass (no API calls) counts symbols and predicts cost and duration.

4. **Triage** -- Files are classified into `skip` or `evaluate` tiers. Barrel exports (`index.ts` that only re-exports), type-only files, and trivial files skip review at zero API cost.

5. **Usage graph** -- A one-pass import resolution builds a project-wide usage graph, so the agent knows which symbols are imported where without making redundant tool calls.

6. **RAG index** -- Local code embeddings (768-dim vectors) are computed with Jina Embeddings V2 Base Code and stored in LanceDB. This enables semantic duplication detection across files. Zero API cost.

7. **Review** -- Each file in the `evaluate` tier is reviewed by Claude agents running all seven axes in parallel (correction, overengineering, utility, duplication, tests, best practices, documentation). The agent can grep the project, read other files, and query the RAG index. Findings must include evidence.

8. **Report** -- Reviews are aggregated into a Markdown report with a per-file summary, severity-sorted findings, and a global verdict.

### What gets created

After the first run, your project will contain:

```
.anatoly/
  cache/
    progress.json    # Per-file review status (PENDING/DONE/CACHED/ERROR)
  tasks/
    <filename>.task.json  # Per-file review task files
  rag/               # LanceDB vector index + embeddings cache
  runs/
    2026-03-15_143022/
      report.md      # The audit report
      reviews/       # Per-file review JSON
      logs/          # Per-file agent transcripts
      anatoly.ndjson # Structured run log
      run-metrics.json # Timing, cost, and stats
```

The `.anatoly/` directory is fully local and safe to `.gitignore`. On subsequent runs, unchanged files (same SHA-256 hash) are skipped automatically.

### Subsequent runs

```bash
anatoly run                  # Only reviews changed files (cache hit on unchanged)
anatoly run --no-cache       # Reset CACHED files to PENDING (DONE files only re-review on hash change)
anatoly run --file "src/core/**"  # Review only matching files
anatoly run --run-id v1.2    # Custom run ID instead of timestamp
```

## Verify it works

After the run completes, you will see output like:

```
review complete -- 42 files | 7 findings | 35 clean (12 skipped . 30 evaluated) | 4m 23s

  run          2026-03-15_143022
  report       .anatoly/runs/2026-03-15_143022/report.md
  reviews      .anatoly/runs/2026-03-15_143022/reviews/
  transcripts  .anatoly/runs/2026-03-15_143022/logs/
  log          .anatoly/runs/2026-03-15_143022/anatoly.ndjson
```

Open the report to see findings:

```bash
anatoly run --open    # Opens report in default app after generation
# or
cat .anatoly/runs/<run-id>/report.md
```

Exit codes:
- `0` -- All files are CLEAN
- `1` -- One or more findings reported
- `2` -- Fatal error (invalid configuration or runtime error)
