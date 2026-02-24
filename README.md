<p align="center">
  <img src="assets/imgs/logo.jpg" alt="Anatoly"/>
</p>

# Anatoly

*"Can I clean here ?"*

**Deep Audit Agent for TypeScript codebases**

*Burn your daily context to deep clean your code.*

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/) [![License: Apache--2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) [![Claude Agent SDK](https://img.shields.io/badge/Powered%20by-Claude%20Agent%20SDK-blueviolet)](https://docs.anthropic.com)

---

## What is Anatoly?

Anatoly sends every TypeScript/TSX file in your project through a Claude AI agent for rigorous, evidence-based code review. The agent has full read access to the codebase during review — it can grep, read files, and search — and produces structured, Zod-validated audit reports.

It enters your codebase, finds the dead code, the duplicated, the superfluous and the over-engineered... and delivers a surgical audit report that only an LLM agent can produce.

**Core philosophy:** High token cost is acceptable to achieve zero false positives. Anatoly never modifies source code — it only diagnoses.

## The Problem

TypeScript codebases accumulate technical debt fast — especially when AI-assisted coding tools generate large volumes of code. Dead code, hidden duplication, over-engineered abstractions, and missing test coverage silently degrade maintainability. Traditional linters catch syntax issues but miss architectural rot. Manual code review doesn't scale.

## How Anatoly Solves It

Anatoly is an **agentic CLI** that parses your codebase with tree-sitter AST analysis, then runs a Claude agent on each file with full codebase context. The agent must **prove** every finding (grep for usage, read target files to confirm duplication) before reporting it. Results are Zod-validated and aggregated into an actionable audit report.

## Key Features

- **AST-driven scanning** — Uses web-tree-sitter (WASM) to extract every function, class, type, enum, constant, and hook with line ranges and export status
- **Evidence-based review** — The Claude agent must grep/read to prove DEAD, DUPLICATE, or OVER findings — no guessing
- **5-axis analysis** — Every symbol evaluated on: correction, overengineering, utility, duplication, and test coverage
- **Zod-validated output** — Machine-readable `.rev.json` + human-readable `.rev.md` per file, all schema-validated
- **Smart caching** — SHA-256 per file; unchanged files skip review at zero API cost
- **Token estimation** — Local tiktoken estimation before any API call (no surprise bills)
- **RAG semantic duplication** — Local embeddings (Xenova/all-MiniLM-L6-v2) + LanceDB vector store detect cross-file semantic duplications invisible to grep
- **Run-scoped outputs** — Each run is stored in `.anatoly/runs/<timestamp>/` with a `latest` symlink; old runs auto-purged via `output.max_runs`
- **Watch mode** — Daemon that re-reviews changed files automatically
- **CI-friendly** — Exit codes: `0` (clean), `1` (findings), `2` (error)
- **Coverage integration** — Parses Istanbul/Vitest/Jest coverage data to enrich reviews
- **Crash-resilient** — Atomic state writes, lock files, and interrupted-run recovery

## Target Audience

Senior developers, Tech Leads, and teams working in TypeScript/React/Node.js — especially those producing large amounts of AI-generated code with tools like Claude Code, Cursor, or Windsurf. Designed for projects from 20 to 1,000+ TypeScript files.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      CLI (Commander.js)                       │
│  run | scan | estimate | review | report | watch | rag-status │
└──────────────┬───────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────┐
│                       Core Pipeline                           │
│                                                               │
│  Scanner ──► Estimator ──► [RAG Index] ──► Reviewer ──► Reporter │
│  (AST+SHA)   (tiktoken)   (Haiku+Xenova)  (Agent SDK)  (aggregate)│
└───────────────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────┐
│                    .anatoly/ (output)                          │
│  cache/ tasks/ rag/lancedb/ runs/<runId>/{reviews,logs,report} │
└───────────────────────────────────────────────────────────────┘
```

The pipeline is strictly sequential per run: **scan** parses AST and computes hashes, **estimate** counts tokens locally, **index** (optional, with `--enable-rag`) generates FunctionCards via Haiku and embeds them locally into LanceDB, **review** runs one Claude Agent SDK session per file (read-only tools: Glob, Grep, Read + findSimilarFunctions when RAG is active), and **report** aggregates all `.rev.json` files into a final `report.md`. Each run's outputs are stored in `.anatoly/runs/<timestamp>/`.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ |
| Language | TypeScript (ESM, strict mode) |
| CLI | Commander.js |
| Build | tsup (esbuild) |
| Tests | Vitest |
| Lint | ESLint (flat config) |
| AST | web-tree-sitter (WASM) |
| Schema | Zod v4 |
| AI Agent | @anthropic-ai/claude-agent-sdk |
| Tokens | tiktoken (local) |
| Watcher | chokidar v5 |
| Terminal | ora + log-update + chalk |
| Embeddings | Xenova/all-MiniLM-L6-v2 (384 dim, local) |
| Vector Store | LanceDB (embedded, zero-server) |

## Project Structure

```
src/
├── index.ts              # Entry point
├── cli.ts                # Command registration + global flags
├── commands/             # One file per CLI command (thin wrappers)
│   ├── run.ts            # Orchestrates: scan → estimate → [index] → review → report
│   ├── watch.ts          # File watcher daemon
│   ├── scan.ts           # Parse AST + compute hashes
│   ├── estimate.ts       # Token estimation
│   ├── review.ts         # Run Claude agent reviews
│   ├── report.ts         # Aggregate → report.md
│   ├── status.ts         # Show progress
│   ├── rag-status.ts     # Inspect RAG index + function cards
│   ├── clean-logs.ts     # Delete old runs (alias: clean-runs)
│   └── reset.ts          # Wipe all state
├── core/                 # Business logic
│   ├── scanner.ts        # AST + SHA-256 + coverage
│   ├── estimator.ts      # tiktoken token counting
│   ├── reviewer.ts       # Claude Agent SDK + Zod retry
│   ├── review-writer.ts  # Writes .rev.json + .rev.md
│   ├── reporter.ts       # Aggregates → report.md
│   └── progress-manager.ts # Atomic state management
├── schemas/              # Zod schemas (source of truth)
│   ├── review.ts         # 5-axis review schema
│   ├── task.ts           # AST task schema
│   ├── config.ts         # Config file schema
│   └── progress.ts       # Progress state schema
├── rag/                  # Semantic RAG module
│   ├── types.ts          # FunctionCard schema + types
│   ├── embeddings.ts     # Xenova/all-MiniLM-L6-v2 (local)
│   ├── vector-store.ts   # LanceDB wrapper
│   ├── indexer.ts        # Incremental indexing + AST extraction
│   ├── card-generator.ts # FunctionCard generation via Haiku
│   ├── orchestrator.ts   # Index pipeline orchestration
│   ├── tools.ts          # findSimilarFunctions MCP server
│   └── index.ts          # Barrel export
└── utils/                # Cross-cutting utilities
    ├── cache.ts           # SHA-256 + atomic writes
    ├── config-loader.ts   # YAML → typed Config
    ├── lock.ts            # PID-based lock file
    ├── prompt-builder.ts  # Agent prompt construction
    ├── renderer.ts        # Terminal rendering (TTY/plain)
    ├── run-id.ts          # Run ID generation + symlink + purge
    ├── extract-json.ts    # JSON extraction from agent responses
    └── git.ts             # .gitignore filtering
```

Runtime output directory:

```
.anatoly/
├── cache/progress.json                    # Pipeline state
├── tasks/*.task.json                      # AST + hash per file
├── rag/                                   # RAG semantic index
│   ├── lancedb/                           # LanceDB vector store
│   └── cache.json                         # File hash → lastIndexed
└── runs/                                  # Run-scoped outputs
    ├── latest → <runId>                   # Symlink to latest run
    └── <YYYY-MM-DD_HHmmss>/
        ├── reviews/*.rev.json             # Machine-readable reviews
        ├── reviews/*.rev.md               # Human-readable reviews
        ├── logs/*.transcript.md           # Full agent reasoning logs
        └── report.md                      # Aggregated audit report
```

---

## Prerequisites

- Node.js >= 20.19
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Getting Started

```bash
# Run without installing
npx anatoly run

# Or install globally
npm install -g anatoly
anatoly run
```

The `run` command executes the full pipeline: **scan** → **estimate** → **[index]** → **review** → **report**. The index phase runs only when `--enable-rag` is set.

## Usage

### Commands

```bash
npx anatoly run            # Full pipeline: scan → estimate → [index] → review → report
npx anatoly watch          # Daemon mode: re-review on file change
npx anatoly scan           # Parse AST + compute SHA-256 hashes
npx anatoly estimate       # Estimate token cost (local, no API calls)
npx anatoly review         # Run Claude agent on pending files
npx anatoly report         # Aggregate reviews → report.md
npx anatoly status         # Show current audit progress
npx anatoly rag-status     # Show RAG index stats (cards, files)
npx anatoly rag-status <fn> # Inspect a specific function card
npx anatoly clean-logs     # Delete old runs (alias: clean-runs)
npx anatoly reset          # Wipe all cache, reviews, and logs
```

### Global Flags

```
--config <path>    Path to .anatoly.yml config file
--verbose          Enable verbose output
--no-cache         Skip cache, re-review all files
--file <glob>      Target specific files (e.g. "src/utils/**/*.ts")
--plain            Disable spinners and colors
--no-color         Disable colors only
--run-id <id>      Custom run ID (default: YYYY-MM-DD_HHmmss)
--enable-rag       Enable semantic RAG cross-file duplication detection
--rebuild-rag      Force full RAG re-indexation
```

### RAG Status Options

```bash
npx anatoly rag-status             # Show index stats (cards, files, last indexed)
npx anatoly rag-status myFunction  # Inspect a function card by name
npx anatoly rag-status --all       # List all indexed function cards
npx anatoly rag-status --json      # Output as JSON (for scripting)
```

### Example Output

Each reviewed file produces two outputs:

**`.rev.json`** — Machine-readable, Zod-validated:

| Axis | Values |
|------|--------|
| `correction` | `OK` / `NEEDS_FIX` / `ERROR` |
| `overengineering` | `LEAN` / `OVER` / `ACCEPTABLE` |
| `utility` | `USED` / `DEAD` / `LOW_VALUE` |
| `duplication` | `UNIQUE` / `DUPLICATE` |
| `tests` | `GOOD` / `WEAK` / `NONE` |
| `confidence` | 0–100 |

**`report.md`** — Aggregated report with:
- Executive summary and global verdict (`CLEAN` / `NEEDS_REFACTOR` / `CRITICAL`)
- Findings table sorted by severity
- Recommended actions
- Clean/error file lists

## Configuration

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
  model: "claude-sonnet-4-20250514"
  agentic_tools: true
  timeout_per_file: 180
  max_retries: 3

rag:
  enabled: false    # opt-in via --enable-rag or here

output:
  max_runs: 10      # optional: purge old runs beyond this limit
```

---

## Development Setup

```bash
git clone https://github.com/r-via/anatoly.git
cd anatoly
npm install
```

### Scripts

```bash
npm run dev        # Run with tsx (direct TS execution)
npm run build      # Build with tsup → dist/index.js
npm test           # Run tests with Vitest
npm run lint       # Lint with ESLint
npm run typecheck  # Type check with tsc --noEmit
```

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npx vitest

# Run a specific test file
npx vitest src/core/scanner.test.ts
```

Tests are co-located with source files (`*.test.ts`) and use Vitest.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes and ensure tests pass (`npm test && npm run typecheck`)
4. Commit with a descriptive message
5. Open a Pull Request

Please follow the existing code style and ensure all CI checks pass.

## License

[Apache-2.0](https://opensource.org/licenses/Apache-2.0)

## Contact & Support

- Issues: [github.com/r-via/anatoly/issues](https://github.com/r-via/anatoly/issues)
- Repository: [github.com/r-via/anatoly](https://github.com/r-via/anatoly)
