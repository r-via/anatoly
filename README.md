<p align="center">
  <img src="assets/imgs/logo.jpg" alt="Anatoly"/>
</p>

# Anatoly

*"Can I clean here?"*

**The AI agent that deep-audits your codebase, and proves every finding.**

Named after [a certain cleaning man](https://www.youtube.com/@vladimirfitness) who politely asks *"Can I clean here?"* — then deadlifts the entire rack.

[![Website](https://img.shields.io/badge/website-anatoly.cloud-1f6feb)](https://anatoly.cloud/) [![Node.js](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0) [![Claude Agent SDK](https://img.shields.io/badge/Powered%20by-Claude%20Agent%20SDK-blueviolet)](https://docs.anthropic.com)

```bash
npx anatoly run   # one command, full codebase audit
```

This program is entirely free — don't forget to leave a ⭐ on the [repo](https://github.com/r-via/anatoly) to help it get started.

---

## What is Anatoly?

<p align="center">
  <img src="assets/anims/demo.gif" alt="Anatoly demo"/>
</p>

You run:

```bash
npx anatoly run
```

A few minutes later, you get a report like this:

> **15 files reviewed in 10 min — $6.13 in AI analysis so you don't have to.**
> Verdict: **NEEDS_REFACTOR** · 26 findings in 11 files
>
> | Axis | Health |
> |------|--------|
> | Correction      | 🟥🟥🟥🟥🟥🟥🟥🟥🟥⬜ 93% OK |
> | Utility         | 🟥🟥🟥🟥🟥🟥🟥🟥⬜⬜ 83% used |
> | Duplication     | 🟥🟥🟥🟥🟥🟥🟥🟥🟥⬜ 90% unique |
> | Overengineering | 🟩🟩🟩🟩🟩🟩🟩🟩🟩⬜ 90% lean |
> | Best Practices  | 🟥🟥🟥🟥🟥🟥🟥⬜⬜⬜ avg 7.4 / 10 |

And findings like these — each one with file+line, a verdict, and the evidence that produced it:

- 🐛 **`src/engine.ts` `computePayout`** — the house-edge multiplier sign is inverted: it *boosts* payout instead of reducing it. RTP is broken.
- 🐛 **`src/rng.ts` `weightedPick`** — `Math.random()` used as the RNG source in a function whose own docstring says *"suitable for gaming RNG applications"*.
- ♻️ **`src/types.ts` `LegacySpinResult`** — exported, imported by 0 files.
- 📋 **`src/engine.ts` `checkLine`** ⇄ **`src/paytable.ts` `lineWins`** — semantically identical (RAG cosine 0.852): same WILD-skip, same consecutive-match loop, different names. A textual diff would never see it.
- 🏗️ **`src/engine.ts` `EngineContainer`** — bespoke IoC container backed by a stringly-typed `Map<string, unknown>`, holding three values.

### How it actually works

Anatoly is a Claude agent with read access to your whole repo, plus a local semantic index (LanceDB + code embeddings, $0/run after the first build). Before reporting anything, it must **prove** it: grep the codebase for usages, read the consumers, query the RAG index for semantic twins, cross-reference imports and tests. Seven axes run in parallel per file (correction, utility, duplication, overengineering, tests, best practices, documentation), each crash-isolated.

**One command. Full codebase. Evidence-backed findings. No code modified.**

Languages: TypeScript, Python, Rust, Go, Java, C#, Bash, SQL, YAML, JSON — auto-detected, AST-parsed via tree-sitter.

## Run and walk away

A 15-file audit takes ~10 minutes. You don't sit through it — Anatoly pings you when it's done.

<p align="center">
  <img src="assets/imgs/banner_telegram.jpg" width="600" alt="Telegram notification" />
</p>

```bash
anatoly notifications create-bot   # one-time wizard, ~2 min
```

The wizard creates a bot, saves the token, registers your Telegram username. On every `anatoly run`, you get a message with the verdict, per-axis scorecard, top findings, and a link to the full report.

**One bot, whole team.** Other developers just add their username to `.anatoly.yml` — Anatoly resolves it to a chat ID on first run and caches it. No per-user token setup.

**Fire-and-forget.** Missing token, unresolved username, Telegram API down — the run logs a warning and produces the report anyway. Notifications never block the pipeline.

Two siblings cover the same async philosophy:

- **Watch mode** (`anatoly watch`) — daemon that re-audits incrementally on file change.
- **Claude Code hook** — write → audit → fix loop (PostToolUse + Stop hooks with anti-loop protection), so the audit fires inside your editor session.

See [Telegram setup](docs/05-Integration/04-Telegram-Notifications.md), [Watch Mode](docs/05-Integration/03-Watch-Mode.md), and [Claude Code Hooks](docs/05-Integration/01-Claude-Code-Hooks.md).

---

> **Fair warning:** This project is context-and-time-hungry by design. Dream-quality code doesn't come cheap -- it takes serious effort (and tokens) to get there.

---

## The Problem

TypeScript codebases accumulate technical debt fast, especially when AI-assisted coding tools generate large volumes of code. Dead code, hidden duplication, over-engineered abstractions, and missing test coverage silently degrade maintainability.

Traditional linters catch syntax issues but miss architectural rot. Manual code review doesn't scale. And no existing tool can answer *"is this function actually used anywhere?"* with certainty, because that requires understanding the whole project, not just one file.

## Key Features

- **7-axis analysis** — correction, overengineering, utility, duplication, tests, best practices, documentation — all axes run in parallel per file, each crash-isolated
- **Evidence-based review** — the agent must grep/read to prove every finding before reporting it — no guesswork, no hallucinated issues
- **3-tier refinement** — post-review pipeline that eliminates false positives: tier 1 auto-resolves trivially wrong findings (usage graph, AST, RAG — 0 tokens), tier 2 detects inter-axis contradictions (DEAD+NEEDS_FIX is moot), tier 3 launches an Opus agent with full tool access (Read, Grep, Bash, WebFetch) to investigate ambiguous findings with empirical evidence. -22% faster, -20% cheaper, +150% CLEAN files vs legacy per-file deliberation
- **Two-pass correction** — re-evaluates findings against dependency documentation (package.json + node_modules READMEs) to eliminate API-misunderstanding false positives
- **Refinement cache** — per-finding persistence in `refinement-cache.json` enables crash recovery (resumes at next finding) and prevents re-investigation across runs
- **Deliberation memory** — persistent reclassification registry prevents repeated false positives across runs, covers all axes
- **RAG semantic duplication** — local code embeddings + dual code+NLP embedding for hybrid similarity search via LanceDB. Concept-level matching, not just syntax
- **RAG-powered documentation review** — function summaries (Haiku) and doc sections are embedded as NLP vectors. The documentation axis evaluates quality by semantic similarity. Separate from `anatoly docs` which manages internal documentation
- **Internal doc pipeline** — `anatoly docs scaffold` generates `.anatoly/docs/` via Sonnet (parallel scaffold → Opus coherence review → RAG index → gap-driven update). Incremental updates at each run via RAG gap detection (cosine similarity, $0). Doc sections are smart-chunked programmatically (H2+H3+paragraph splitting, no LLM cost) and re-indexed inline after each doc update. `anatoly docs scaffold project` copies internal docs to `docs/` for publishing
- **Auto-Clean** (inspired by [Ralph Pattern](https://paddo.dev/blog/ralph-wiggum-autonomous-loops/)) — `anatoly clean run` launches an autonomous correction loop that commits each remediation individually and syncs progress back to the report
- **Claude Code hook** — real-time audit loop: write → audit → fix (PostToolUse + Stop hooks with anti-loop protection)
- **Smart triage** — auto-classifies files into skip/evaluate tiers (barrel exports, type-only, trivial files skip at zero API cost)
- **Pre-computed usage graph** — one-pass import resolution across all files with transitive intra-file references, eliminating ~90% of redundant tool calls
- **Local code embeddings** — Jina v2 (768d) on CPU or nomic-embed-code (3584d) + Qwen3-Embedding-8B (4096d) on GPU — zero API cost for RAG indexing
- **Multi-language support** — TypeScript, Python, Rust, Go, Java, C#, Bash, SQL, YAML, JSON with auto-detection. Language-specific best-practices prompts, framework-aware evaluation (React, Next.js)
- **AST-driven scanning** — web-tree-sitter extracts every symbol (functions, classes, types, enums, hooks, constants) with line ranges and export status for each supported language
- **Sharded reports** — compact index + per-shard detail files with symbol-level tables, severity-sorted actions, and checkboxes for clean loop consumption
- **Smart caching** — SHA-256 per file; unchanged files skip review at zero API cost. Second run on unchanged codebase costs $0
- **Dry-run mode** — `--dry-run` simulates the full pipeline (scan, estimate, triage, cost) without API calls. Uses calibrated per-axis timing from past runs
- **Watch mode** — daemon that monitors file changes and triggers incremental re-review + report regeneration
- **CI-friendly** — exit codes `0`/`1`/`2`, `--plain` mode for non-interactive pipelines, colored cost display
- **Multi-provider LLM** (experimental) — Gemini 2.5 Flash routes utility, duplication, overengineering axes and NLP summarization at $0/token via Google OAuth. Circuit breaker auto-falls back to Claude on failure. Reduces Claude API calls by ~69%

> See [Pipeline Overview](docs/02-Architecture/01-Pipeline-Overview.md) for the full pipeline details, and [Seven-Axis System](docs/02-Architecture/02-Seven-Axis-System.md) for the evaluation axes.

### Seven-Axis System

Every file is evaluated through seven independent axes, running in parallel. Each axis focuses on a single dimension of code quality:

| Axis | Default Model | Verdicts | What it detects |
|------|---------------|----------|-----------------|
| **Utility** | Gemini Flash | `USED` `DEAD` `LOW_VALUE` | Dead or unused exports, low-value code |
| **Duplication** | Gemini Flash | `UNIQUE` `DUPLICATE` | Semantically similar functions across the codebase |
| **Correction** | Sonnet | `OK` `NEEDS_FIX` `ERROR` | Bugs, logic errors, async issues (two-pass with dependency verification) |
| **Overengineering** | Gemini Flash | `LEAN` `OVER` `ACCEPTABLE` | Excessive complexity relative to purpose |
| **Tests** | Sonnet | `GOOD` `WEAK` `NONE` | Test coverage quality per symbol |
| **Best Practices** | Sonnet | Score 0-10, 17 rules | Language-specific best-practice violations (context-aware) |
| **Documentation** | Sonnet | `DOCUMENTED` `PARTIAL` `UNDOCUMENTED` | JSDoc gaps on exports, /docs/ desynchronization |

Run specific axes with `--axes`:

```bash
npx anatoly run --axes utility              # single axis
npx anatoly run --axes correction,tests     # multiple axes
npx anatoly run                             # all seven (default)
```

> Each axis is crash-isolated — if one fails, the other six still produce results. See [Seven-Axis System](docs/02-Architecture/02-Seven-Axis-System.md) for scoring model, merger logic, and model configuration.

## Target Audience

Senior developers, Tech Leads, and teams working in TypeScript, Python, Rust, Go, Java, C#, and more -- especially those producing large amounts of AI-generated code with tools like Claude Code, Cursor, or Windsurf. Designed for projects from 20 to 1,000+ source files.

---

## Prerequisites

- Node.js >= 20.19
- **One LLM auth path** — Anatoly works with any of:
  - **Subscription (default)** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed + logged in. Drives Anatoly via your Claude.ai subscription. **No API key needed.**
  - **Subscription (Google)** — Google OAuth via [Gemini CLI](https://github.com/google-gemini/gemini-cli). Routes axes to Gemini at $0/token. No API key needed.
  - **BYOK API** — set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.) and flip the provider's `mode: api` in `.anatoly.yml`.
  - **Local** — Ollama, LM Studio, vLLM, or any OpenAI-compatible local server. Zero data leaves your network.

  See [Recommended LLM Setup](docs/01-Getting-Started/03-Recommended-LLM-Setup.md) for per-tier model picks and [Installation](docs/01-Getting-Started/01-Installation.md#prerequisites) for the auth-mode matrix.

### Optional but recommended: GPU-accelerated embeddings

By default, Anatoly uses ONNX-based code embeddings (Jina v2, 768d) running on CPU. For significantly better duplication detection, set up **Advanced-GGUF mode** which runs Docker llama.cpp server-cuda containers with GGUF Q5_K_M quantized models on GPU:

- **Code:** nomic-embed-code (3584d)
- **NLP:** Qwen3-Embedding-8B (4096d)
- **Sequential mode:** one model loaded at a time (~10 GB VRAM), swaps automatically

**Requirements:** Docker, an NVIDIA GPU with >= 12 GB VRAM

```bash
# One-time setup: pulls Docker images, downloads GGUF models (SHA256-verified)
npx anatoly local-embeddings upgrade

# Check status anytime
npx anatoly local-embeddings status
```

Containers start automatically with `anatoly run` when setup is detected. No Python dependency -- Docker is the only runtime requirement for GPU mode.

## Getting Started

```bash
# Run without installing
npx anatoly run

# Or install globally
npm install -g anatoly
anatoly run
```

The `run` command executes the full pipeline: **scan** → **estimate** → **triage** → **usage graph** → **RAG index** → **review** → **doc update** → **report**. RAG indexing is enabled by default; use `--no-rag` to skip it. Internal docs are auto-scaffolded on first run if `.anatoly/docs/` doesn't exist.

## Usage

```bash
# Core pipeline
npx anatoly run                  # Full pipeline: scan → estimate → index → review → doc update → report
npx anatoly run --run-id X       # Custom run ID (default: YYYY-MM-DD_HHmmss)
npx anatoly watch                # Daemon mode: initial scan + incremental re-review on change/delete

# Individual phases
npx anatoly scan                 # Parse AST + compute SHA-256 hashes
npx anatoly estimate             # Pre-run forecast: tokens, cost, time + per-step breakdown (no API calls)
npx anatoly estimate --json      # Same forecast, machine-readable JSON to stdout
npx anatoly review               # Run Claude agent on pending files
npx anatoly report               # Aggregate reviews → report.md

# Documentation management
npx anatoly docs scaffold              # Generate .anatoly/docs/ (full pipeline: scaffold → coherence → RAG → update)
npx anatoly docs scaffold project      # Copy .anatoly/docs/ → docs/ (scaffolds internal first if needed)
npx anatoly docs index                 # Incremental RAG indexing: code + NLP summaries + doc chunks
npx anatoly docs index --rebuild       # Force full re-index
npx anatoly docs gap-detection internal  # Analyze coverage gaps in .anatoly/docs/ vs code (no LLM, $0)
npx anatoly docs gap-detection project   # Analyze coverage gaps in docs/ vs code
npx anatoly docs lint                  # Deterministic structure lint on .anatoly/docs/
npx anatoly docs coherence             # Lint + Opus coherence review on .anatoly/docs/
npx anatoly docs status                # Show internal docs coverage

# Auto-clean
npx anatoly clean generate documentation  # Generate clean loop artifacts from axis findings
npx anatoly clean run documentation       # Generate + run clean loop to auto-clean findings
npx anatoly clean sync documentation      # Sync completed clean tasks back to the report

# Maintenance
npx anatoly status               # Show current audit progress
npx anatoly rag-status           # Show RAG index stats
npx anatoly clean runs           # Delete old runs (--keep <n>, --yes)
npx anatoly reset                # Wipe all state (runs, cache, RAG, internal docs)
npx anatoly reset --keep-docs    # Wipe state but keep internal docs
npx anatoly hook init            # Generate Claude Code hooks configuration
npx anatoly init                 # Generate .anatoly.yml with all defaults (commented out)
npx anatoly local-embeddings upgrade  # Install GPU-accelerated embeddings (Docker GGUF)
npx anatoly providers            # Verify LLM connectivity (Claude + Gemini)
npx anatoly notifications create-bot  # Interactive Telegram bot setup wizard
npx anatoly notifications test   # Send a test Telegram notification
npx anatoly report --notify      # Re-generate report + send notification

# Useful flags
npx anatoly run --dry-run        # Simulate: scan, estimate, triage — no API calls
npx anatoly run --no-deliberation # Skip the Opus deliberation pass
npx anatoly run --no-rag         # Skip RAG indexing
npx anatoly run --plain          # Linear output for CI/scripts
```

> See [Configuration](docs/01-Getting-Started/02-Configuration.md) for the full `.anatoly.yml` reference, all CLI flags, and [`ANATOLY.md` project instructions](docs/01-Getting-Started/02-Configuration.md#project-instructions-anatolymd).

### Dual Embedding (Code + NLP)

Anatoly always uses **dual embedding** — two specialized models working together:

- **Code embedding** — function bodies embedded directly for structural similarity (catches syntactic duplicates)
- **NLP embedding** — Haiku generates a natural language summary, key concepts, and behavioral profile for each function, then embedded with a dedicated NLP model (catches semantic duplicates)

During search, both scores are combined via hybrid similarity:

```
hybrid_score = code_weight × code_similarity + (1 - code_weight) × nlp_similarity
```

This catches functions that **do the same thing** but are implemented differently (different libraries, different paradigms, different naming).

The NLP embeddings also power **doc gap detection** — comparing function summaries against documentation chunks to find undocumented code.

#### Embedding models

At startup, Anatoly detects available hardware and selects the best models:

| Mode | Code Model | NLP Model | Requirements |
|------|-----------|-----------|-------------|
| **Advanced (GGUF)** | nomic-embed-code (3584d) | Qwen3-Embedding-8B (4096d) | Docker + NVIDIA GPU ≥ 12 GB VRAM |
| **Lite (ONNX)** | Jina v2 (768d) | all-MiniLM-L6-v2 (384d) | CPU only |

```yaml
# .anatoly.yml
rag:
  enabled: true
  code_model: auto   # 'auto' = hardware-based selection
  nlp_model: auto    # 'auto' = best available
  code_weight: 0.6   # 60% code similarity, 40% NLP similarity
```

---

## Documentation

| Section | Highlights |
|---------|------------|
| [Getting Started](docs/01-Getting-Started/) | [Vision](docs/01-Getting-Started/00-Vision.md), [Installation](docs/01-Getting-Started/01-Installation.md), [Configuration](docs/01-Getting-Started/02-Configuration.md) |
| [Architecture](docs/02-Architecture/) | [Pipeline](docs/02-Architecture/01-Pipeline-Overview.md), [7-Axis System](docs/02-Architecture/02-Seven-Axis-System.md), [RAG Engine](docs/02-Architecture/03-RAG-Engine.md), [Usage Graph](docs/02-Architecture/04-Usage-Graph.md), [Deliberation](docs/02-Architecture/05-Deliberation-Pass.md) |
| [CLI Reference](docs/03-CLI-Reference/) | [Commands](docs/03-CLI-Reference/01-Commands.md), [Global Options](docs/03-CLI-Reference/02-Global-Options.md), [Output Formats](docs/03-CLI-Reference/03-Output-Formats.md) |
| [Core Modules](docs/04-Core-Modules/) | [Scanner](docs/04-Core-Modules/01-Scanner.md), [Estimator](docs/04-Core-Modules/02-Estimator.md), [Triage](docs/04-Core-Modules/03-Triage.md), [Evaluators](docs/04-Core-Modules/04-Axis-Evaluators.md), [Reporter](docs/04-Core-Modules/05-Reporter.md), [Worker Pool](docs/04-Core-Modules/06-Worker-Pool.md) |
| [Integration](docs/05-Integration/) | [Claude Code Hooks](docs/05-Integration/01-Claude-Code-Hooks.md), [CI/CD](docs/05-Integration/02-CI-CD.md), [Watch Mode](docs/05-Integration/03-Watch-Mode.md), [Telegram Notifications](docs/05-Integration/04-Telegram-Notifications.md) |
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

By contributing, you agree to the [Contributor License Agreement](CLA.md).
This is necessary because Anatoly uses dual licensing (AGPL-3.0 + commercial).

Please follow the existing code style and ensure all CI checks pass.

## License

Anatoly is dual-licensed:

- **Open source** — [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0):
  free for open source, personal, and academic use.
- **Commercial** — a proprietary license is available for companies that
  cannot comply with AGPL-3.0. See [COMMERCIAL.md](COMMERCIAL.md) for
  details.

## Contact & Support

- Website: [anatoly.cloud](https://anatoly.cloud/)
- Issues: [github.com/r-via/anatoly/issues](https://github.com/r-via/anatoly/issues)
- Repository: [github.com/r-via/anatoly](https://github.com/r-via/anatoly)

<!-- checked-by-anatoly -->
[![Checked by Anatoly](https://img.shields.io/badge/checked%20by-Anatoly-blue)](https://github.com/r-via/anatoly)
<!-- /checked-by-anatoly -->
