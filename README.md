<p align="center">
  <img src="assets/imgs/logo.jpg" alt="Anatoly"/>
</p>

# Anatoly

*"Can I clean here?"*

**The AI agent that deep-audits your TypeScript codebase, and proves every finding.**

Named after [Anatoly Shmondenko](https://www.youtube.com/@vladimirfitness) -- the Ukrainian powerlifter who disguises himself as a scrawny cleaning man, politely asks *"Can I clean here?"*, then casually one-arms 290 kg while bodybuilders stare. Same energy: a humble CLI that walks into your codebase with a mop and deadlifts your entire tech debt off the rack.

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/) [![License: Apache--2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) [![Claude Agent SDK](https://img.shields.io/badge/Powered%20by-Claude%20Agent%20SDK-blueviolet)](https://docs.anthropic.com)

```bash
npx anatoly run   # one command, full codebase audit
```

---

> **Fair warning:** This project is context-and-time-hungry by design. Dream-quality code doesn't come cheap -- it takes serious effort (and tokens) to get there.

---

## What is Anatoly?

Anatoly is an **autonomous AI agent augmented by semantic RAG** that walks through every file in your TypeScript codebase, investigates it with full project context, and delivers a surgical audit report.

This is not a linter. This is not a static analysis rule set. Anatoly is a **Claude agent with read access to your entire codebase and a semantic vector index**. The agent can grep for usages across the project, read other files to verify dead code, query a local RAG index to surface semantically similar functions, and cross-reference exports, imports, and test coverage -- then it must **prove** each finding with evidence before reporting it.

**One command. Full codebase. Evidence-backed findings. No code modified.**

## The Problem

TypeScript codebases accumulate technical debt fast, especially when AI-assisted coding tools generate large volumes of code. Dead code, hidden duplication, over-engineered abstractions, and missing test coverage silently degrade maintainability.

Traditional linters catch syntax issues but miss architectural rot. Manual code review doesn't scale. And no existing tool can answer *"is this function actually used anywhere?"* with certainty, because that requires understanding the whole project, not just one file.

## Key Features

- **AST-driven scanning** — web-tree-sitter extracts every symbol (functions, classes, types, enums, hooks, constants) with line ranges and export status
- **Evidence-based review** — the agent must grep/read to prove every finding before reporting it
- **6-axis analysis** — correction, overengineering, utility, duplication, tests, best practices — all axes run in parallel per file
- **Smart triage** — auto-classifies files into skip/evaluate tiers (barrel exports, type-only, trivial files skip at zero API cost)
- **Pre-computed usage graph** — one-pass import resolution across all files, eliminating ~90% of redundant tool calls
- **Local code embeddings** — Jina Embeddings V2 Base Code (768-dim) computed locally, stored in LanceDB — zero API cost for RAG indexing
- **RAG semantic duplication** — local code embeddings + optional dual code+NLP embedding for hybrid similarity search via LanceDB
- **Opus deliberation** — optional senior-auditor pass detects inter-axis incoherence and filters residual false positives
- **Two-pass correction** — re-evaluates findings against dependency documentation (package.json + node_modules READMEs)
- **Correction memory** — persistent false-positive registry prevents repeated flags across runs
- **Smart caching** — SHA-256 per file; unchanged files skip review at zero API cost
- **Sharded reports** — compact index + per-shard detail files with symbol-level tables, severity-sorted actions
- **Watch mode** — daemon that monitors file changes and triggers incremental re-review + report regeneration
- **Claude Code hook** — real-time audit loop: write → audit → fix (PostToolUse + Stop hooks with anti-loop protection)
- **Auto-clean via Ralph** — `anatoly clean` parses a report shard into Ralph artifacts (prd.json + CLAUDE.md), then `anatoly clean-run` launches an autonomous correction loop that commits each remediation individually and syncs progress back to the report
- **CI-friendly** — exit codes `0`/`1`/`2`, `--plain` mode for non-interactive pipelines

> See [Pipeline Overview](docs/02-Architecture/01-Pipeline-Overview.md) for the full pipeline details, and [Six-Axis System](docs/02-Architecture/02-Six-Axis-System.md) for the evaluation axes.

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

The `run` command executes the full pipeline: **scan** → **estimate** → **triage** → **usage graph** → **RAG index** → **review** → **report**. RAG indexing is enabled by default; use `--no-rag` to skip it.

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
npx anatoly clean report.1.md      # Generate Ralph artifacts from a shard's findings
npx anatoly clean-run report.1.md  # Generate + run Ralph loop to auto-clean findings
npx anatoly clean-sync report.1.md # Sync completed clean tasks back to the report
npx anatoly status               # Show current audit progress
npx anatoly rag-status           # Show RAG index stats (includes dual embedding mode)
npx anatoly clean-runs           # Delete old runs (--keep <n>, --yes)
npx anatoly reset                # Wipe all state
npx anatoly hook init            # Generate Claude Code hooks configuration
```

> See [Configuration](docs/01-Getting-Started/02-Configuration.md) for the full `.anatoly.yml` reference and all CLI flags.

### Dual Embedding (Code + NLP)

By default, Anatoly uses **code-only embedding** -- function bodies are embedded directly using `jina-embeddings-v2-base-code` for structural similarity matching. This catches duplicates that look alike syntactically.

Enable **dual embedding** (`--dual-embedding` or `rag.dual_embedding: true` in config) to add a second **NLP semantic layer**. In dual mode, Anatoly uses the `index_model` (Haiku by default) to generate a natural language summary, key concepts, and behavioral profile for each function, then embeds that NLP text alongside the code.

During duplication search, both scores are combined:

```
hybrid_score = code_weight × code_similarity + (1 - code_weight) × nlp_similarity
```

This catches duplicates that the code-only approach misses -- functions that **do the same thing** but are implemented differently (different libraries, different paradigms, different naming). The code embedding catches structural similarity; the NLP embedding catches intentional similarity.

```yaml
# .anatoly.yml
rag:
  enabled: true
  dual_embedding: true   # Enable NLP summaries + hybrid search
  code_weight: 0.6       # 60% code similarity, 40% NLP similarity (default)
```

> **Note:** Dual embedding adds LLM API calls during indexing (one call per file with functions). This increases indexing cost but significantly improves cross-file duplication detection for semantically similar functions.

---

## Documentation

| Section | Highlights |
|---------|------------|
| [Getting Started](docs/01-Getting-Started/) | [Vision](docs/01-Getting-Started/00-Vision.md), [Installation](docs/01-Getting-Started/01-Installation.md), [Configuration](docs/01-Getting-Started/02-Configuration.md) |
| [Architecture](docs/02-Architecture/) | [Pipeline](docs/02-Architecture/01-Pipeline-Overview.md), [6-Axis System](docs/02-Architecture/02-Six-Axis-System.md), [RAG Engine](docs/02-Architecture/03-RAG-Engine.md), [Usage Graph](docs/02-Architecture/04-Usage-Graph.md), [Deliberation](docs/02-Architecture/05-Deliberation-Pass.md) |
| [CLI Reference](docs/03-CLI-Reference/) | [Commands](docs/03-CLI-Reference/01-Commands.md), [Global Options](docs/03-CLI-Reference/02-Global-Options.md), [Output Formats](docs/03-CLI-Reference/03-Output-Formats.md) |
| [Core Modules](docs/04-Core-Modules/) | [Scanner](docs/04-Core-Modules/01-Scanner.md), [Estimator](docs/04-Core-Modules/02-Estimator.md), [Triage](docs/04-Core-Modules/03-Triage.md), [Evaluators](docs/04-Core-Modules/04-Axis-Evaluators.md), [Reporter](docs/04-Core-Modules/05-Reporter.md), [Worker Pool](docs/04-Core-Modules/06-Worker-Pool.md) |
| [Integration](docs/05-Integration/) | [Claude Code Hooks](docs/05-Integration/01-Claude-Code-Hooks.md), [CI/CD](docs/05-Integration/02-CI-CD.md), [Watch Mode](docs/05-Integration/03-Watch-Mode.md) |
| [Development](docs/06-Development/) | [Source Tree](docs/06-Development/00-Source-Tree.md), [Contributing](docs/06-Development/01-Contributing.md), [Testing](docs/06-Development/02-Testing.md), [Schemas](docs/06-Development/03-Schemas.md) |
| [Design Decisions](docs/07-Design-Decisions/) | [Why Local RAG](docs/07-Design-Decisions/01-Why-Local-RAG.md), [Evidence-Based](docs/07-Design-Decisions/02-Evidence-Based-Approach.md), [Cost Optimization](docs/07-Design-Decisions/03-Cost-Optimization.md) |

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
