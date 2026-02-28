<p align="center">
  <img src="assets/imgs/logo.jpg" alt="Anatoly"/>
</p>

# Anatoly & his Pals

*"Can I clean here?"*

**The AI janitor crew that deep-audits your TypeScript codebase -- and proves every finding.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/) [![License: Apache--2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) [![Claude Agent SDK](https://img.shields.io/badge/Powered%20by-Claude%20Agent%20SDK-blueviolet)](https://docs.anthropic.com)

```bash
npx anatoly run   # one command, full codebase audit
```

---

> **Fair warning:** This project is context-and-time-hungry by design. Dream-quality code doesn't come cheap -- it takes serious effort (and tokens) to get there.

---

## Meet the Crew

Anatoly is the boss. He orchestrates the crew, dispatches each Pal on every file, and compiles their findings into a single evidence-backed audit report. The Pals do the dirty work. Anatoly makes sure it's proven.

| Pal | Axis | Job description |
|-----|------|-----------------|
| **The Perfectionist** | `correction` | Finds bugs, bad patterns, and code that just ain't right |
| **The Minimalist** | `overengineering` | Calls out abstractions nobody asked for |
| **The Bouncer** | `utility` | Kicks out dead code -- no invite, no entry |
| **The Clone Hunter** | `duplication` | Tracks down copy-paste across file boundaries |
| **The Guardian** | `tests` | Guards the gate -- no coverage, no mercy |
| **The Coach** | `best_practices` | Scores every file against 17 TypeScript best-practice rules |

---

## What is Anatoly?

Anatoly runs a crew of six specialized Pals -- each one an analysis axis powered by a Claude agent with full read access to your codebase and a semantic vector index. Together they walk through every file, investigate it with full project context, and deliver a surgical audit report.

This is not a linter. This is not a static analysis rule set. Anatoly is a **Claude agent with read access to your entire codebase and a semantic vector index**. The agent can grep for usages across the project, read other files to verify dead code, query a local RAG index to surface semantically similar functions, and cross-reference exports, imports, and test coverage -- then it must **prove** each finding with evidence before reporting it.

**One command. Full codebase. Evidence-backed findings. No code modified.**

## The Problem

TypeScript codebases accumulate technical debt fast, especially when AI-assisted coding tools generate large volumes of code. Dead code, hidden duplication, over-engineered abstractions, and missing test coverage silently degrade maintainability.

Traditional linters catch syntax issues but miss architectural rot. Manual code review doesn't scale. And no existing tool can answer *"is this function actually used anywhere?"* with certainty, because that requires understanding the whole project, not just one file.

## Key Features

- **AST-driven scanning** — tree-sitter extracts every symbol with line ranges and export status
- **Evidence-based review** — the agent must grep/read to prove every finding
- **6-axis analysis** — correction, overengineering, utility, duplication, tests, best practices
- **Smart triage** — auto-classifies files into skip/fast/deep tiers
- **Pre-computed usage graph** — full import graph in < 1s, eliminating ~90% of redundant tool calls
- **RAG semantic duplication** — local code embeddings + optional dual code+NLP embedding for hybrid similarity search via LanceDB
- **Opus deliberation** — optional post-merge validation pass filters residual false positives
- **Smart caching** — SHA-256 per file; unchanged files skip review at zero API cost
- **Sharded reports** — compact index + per-shard detail files with symbol-level tables
- **Claude Code hook** — real-time audit loop: write → audit → fix
- **CI-friendly** — exit codes `0`/`1`/`2`, `--plain` mode, `--yes` for non-interactive use

> See [How It Works](docs/how-it-works.md) for the full pipeline details, self-correction loop, two-pass correction, and deliberation pass.

## Target Audience

Senior developers, Tech Leads, and teams working in TypeScript/React/Node.js -- especially those producing large amounts of AI-generated code with tools like Claude Code, Cursor, or Windsurf. Designed for projects from 20 to 1,000+ TypeScript files.

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

The `run` command executes the full pipeline: **scan** → **estimate** → **index** → **review** → **report**. RAG indexing is enabled by default; use `--no-rag` to skip it.

## Usage

```bash
npx anatoly run                  # Full pipeline: scan → estimate → index → review → report
npx anatoly run --dual-embedding # Enable dual code+NLP embedding for improved duplication detection
npx anatoly run --run-id X       # Custom run ID (default: YYYY-MM-DD_HHmmss)
npx anatoly watch                # Daemon mode: initial scan + incremental re-review on change/delete
npx anatoly scan                 # Parse AST + compute SHA-256 hashes
npx anatoly estimate             # Estimate token cost (local, no API calls)
npx anatoly review               # Run Claude agent on pending files
npx anatoly report               # Aggregate reviews → report.md
npx anatoly status               # Show current audit progress
npx anatoly rag-status           # Show RAG index stats (includes dual embedding mode)
npx anatoly clean-runs           # Delete old runs (--keep <n>, --yes)
npx anatoly reset                # Wipe all state
npx anatoly hook init            # Generate Claude Code hooks configuration
```

> See [Configuration](docs/configuration.md) for the full `.anatoly.yml` reference and all CLI flags.

### Dual Embedding (Code + NLP)

By default, Anatoly uses **code-only embedding** -- function bodies are embedded directly using a code-specific model (Jina v2 by default) for structural similarity matching. This catches duplicates that look alike syntactically.

Enable **dual embedding** (`--dual-embedding` or `rag.dual_embedding: true` in config) to add a second **NLP semantic layer**. In dual mode, Anatoly uses the `index_model` (Haiku by default) to generate a natural language summary, key concepts, and behavioral profile for each function, then embeds that NLP text with a dedicated NLP model (all-MiniLM-L6-v2 by default).

During duplication search, both scores are combined:

```
hybrid_score = code_weight × code_similarity + (1 - code_weight) × nlp_similarity
```

This catches duplicates that the code-only approach misses -- functions that **do the same thing** but are implemented differently (different libraries, different paradigms, different naming). The code embedding catches structural similarity; the NLP embedding catches intentional similarity.

#### Embedding models

At startup, Anatoly detects available hardware (RAM, GPU) and selects the best embedding model. You can override model selection in config or via CLI:

```yaml
# .anatoly.yml
rag:
  enabled: true
  dual_embedding: true   # Enable NLP summaries + hybrid search
  code_model: auto        # 'auto' = hardware-based selection (default: jina-v2-base-code)
  nlp_model: auto         # 'auto' = all-MiniLM-L6-v2 (384d, optimized for text similarity)
  code_weight: 0.6        # 60% code similarity, 40% NLP similarity (default)
```

```bash
# CLI overrides
npx anatoly run --dual-embedding --code-model jinaai/jina-embeddings-v2-base-code --nlp-model Xenova/all-MiniLM-L6-v2
```

Using separate specialized models (code model for structure, NLP model for semantics) produces better results than a single general-purpose model for both tasks.

> **Note:** Dual embedding adds LLM API calls during indexing (one call per file with functions). This increases indexing cost but significantly improves cross-file duplication detection for semantically similar functions.

---

## Documentation

| Document | Description |
|----------|-------------|
| [How It Works](docs/how-it-works.md) | Pipeline details, self-correction loop, two-pass correction, deliberation, Claude Code hook |
| [Architecture](docs/architecture.md) | System diagram, tech stack, project structure, runtime output |
| [Configuration](docs/configuration.md) | `.anatoly.yml` reference, CLI flags, review output format |
| [Logging](docs/logging.md) | Diagnostic logging, log levels, `jq` recipes |

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
npm test                              # Run all tests
npx vitest                            # Watch mode
npx vitest src/core/scanner.test.ts   # Specific test file
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

<!-- checked-by-anatoly -->
[![Checked by Anatoly](https://img.shields.io/badge/checked%20by-Anatoly-blue)](https://github.com/r-via/anatoly)
<!-- /checked-by-anatoly -->
