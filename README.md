<p align="center">
  <img src="assets/imgs/logo.jpg" alt="Anatoly"/>
</p>

# Anatoly

**Deep Audit Agent for TypeScript codebases**

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/) [![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](https://opensource.org/licenses/ISC) [![Claude Agent SDK](https://img.shields.io/badge/Powered%20by-Claude%20Agent%20SDK-blueviolet)](https://docs.anthropic.com)

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
- **Watch mode** — Daemon that re-reviews changed files automatically
- **CI-friendly** — Exit codes: `0` (clean), `1` (findings), `2` (error)
- **Coverage integration** — Parses Istanbul/Vitest/Jest coverage data to enrich reviews
- **Crash-resilient** — Atomic state writes, lock files, and interrupted-run recovery

## Target Audience

Senior developers, Tech Leads, and teams working in TypeScript/React/Node.js — especially those producing large amounts of AI-generated code with tools like Claude Code, Cursor, or Windsurf. Designed for projects from 20 to 1,000+ TypeScript files.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   CLI (Commander.js)             │
│  run | scan | estimate | review | report | watch │
└─────────────┬───────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────┐
│                  Core Pipeline                   │
│                                                  │
│  Scanner ──► Estimator ──► Reviewer ──► Reporter │
│  (AST+SHA)   (tiktoken)   (Agent SDK)  (aggregate)│
└──────────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────┐
│              .anatoly/ (output)                  │
│  cache/ tasks/ reviews/ logs/ report.md          │
└──────────────────────────────────────────────────┘
```

The pipeline is strictly sequential per run: **scan** parses AST and computes hashes, **estimate** counts tokens locally, **review** runs one Claude Agent SDK session per file (read-only tools: Glob, Grep, Read), and **report** aggregates all `.rev.json` files into a final `report.md`.

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

## Project Structure

```
src/
├── index.ts              # Entry point
├── cli.ts                # Command registration + global flags
├── commands/             # One file per CLI command (thin wrappers)
│   ├── run.ts            # Orchestrates: scan → estimate → review → report
│   ├── watch.ts          # File watcher daemon
│   ├── scan.ts           # Parse AST + compute hashes
│   ├── estimate.ts       # Token estimation
│   ├── review.ts         # Run Claude agent reviews
│   ├── report.ts         # Aggregate → report.md
│   ├── status.ts         # Show progress
│   ├── clean-logs.ts     # Delete transcripts
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
└── utils/                # Cross-cutting utilities
    ├── cache.ts           # SHA-256 + atomic writes
    ├── config-loader.ts   # YAML → typed Config
    ├── lock.ts            # PID-based lock file
    ├── prompt-builder.ts  # Agent prompt construction
    ├── renderer.ts        # Terminal rendering (TTY/plain)
    └── git.ts             # .gitignore filtering
```

Runtime output directory:

```
.anatoly/
├── cache/progress.json           # Pipeline state
├── tasks/*.task.json             # AST + hash per file
├── reviews/*.rev.json            # Machine-readable reviews
├── reviews/*.rev.md              # Human-readable reviews
├── logs/*.transcript.md          # Full agent reasoning logs
└── report.md                     # Aggregated audit report
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

The `run` command executes the full pipeline: **scan** → **estimate** → **review** → **report**.

## Usage

### Commands

```bash
npx anatoly run            # Full pipeline: scan → estimate → review → report
npx anatoly watch          # Daemon mode: re-review on file change
npx anatoly scan           # Parse AST + compute SHA-256 hashes
npx anatoly estimate       # Estimate token cost (local, no API calls)
npx anatoly review         # Run Claude agent on pending files
npx anatoly report         # Aggregate reviews → report.md
npx anatoly status         # Show current audit progress
npx anatoly clean-logs     # Delete transcript files
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

[ISC](https://opensource.org/licenses/ISC)

## Contact & Support

- Issues: [github.com/r-via/anatoly/issues](https://github.com/r-via/anatoly/issues)
- Repository: [github.com/r-via/anatoly](https://github.com/r-via/anatoly)
