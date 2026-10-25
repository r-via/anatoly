<p align="center">
  <img src="assets/imgs/logo.jpg" alt="Anatoly"/>
</p>

# Anatoly

*"Can I clean here?"*

**An open source, no-frills code reviewer that out-lifts the giants without raising its voice.**

Anatoly is a deep-audit agent for existing codebases. It evaluates every file on **seven axes**: silent bugs, dead code, semantic duplicates, over-engineering, weak tests, broken best practices, and stale documentation. **Every finding is proven with a file, a line, and the evidence trail that led to it.** No code is modified.

Built for the codebases that grew faster than anyone could review them, especially the ones shipped with Cursor, Claude Code, Lovable, v0, Bolt, or Windsurf.

[![Website](https://img.shields.io/badge/website-anatoly.cloud-1f6feb)](https://anatoly.cloud/) [![Node.js](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

```bash
npx @r-via/anatoly@latest run   # one command, full codebase audit
```

---

## The problem

You shipped fast. Maybe with AI, maybe with a sprint that never ended.
Now the codebase has:

- functions that do the same thing under different names,
- exports nobody imports,
- silent logic bugs the type system can't catch,
- bespoke abstractions wrapping three values,
- "tested" code with no behavioral coverage,
- best-practice rules the team agreed on but stopped enforcing,
- public APIs whose `/docs/` pages drifted out of sync.

Linters won't find this. Type checkers won't either. A senior reviewer
would, if they had a week. **Anatoly does it in minutes, and gives you a
report you can defend.**

---

## What a run looks like

<p align="center">
  <img src="assets/anims/demo.gif" alt="Anatoly demo"/>
</p>

You run one command. A few minutes later, you get a report like this:

> **15 files reviewed in 10 min, $6.13 in AI analysis so you don't have to.**
> Verdict: **NEEDS_REFACTOR** · 26 findings in 11 files
>
> | Axis | Health |
> |------|--------|
> | Correction      | 🟥🟥🟥🟥🟥🟥🟥🟥🟥⬜ 93% OK |
> | Utility         | 🟥🟥🟥🟥🟥🟥🟥🟥⬜⬜ 83% used |
> | Duplication     | 🟥🟥🟥🟥🟥🟥🟥🟥🟥⬜ 90% unique |
> | Overengineering | 🟩🟩🟩🟩🟩🟩🟩🟩🟩⬜ 90% lean |
> | Best Practices  | 🟥🟥🟥🟥🟥🟥🟥⬜⬜⬜ avg 7.4 / 10 |

And findings like these, each one with file+line, a verdict, and the evidence that produced it:

- 🐛 **`src/engine.ts` `computePayout`**: the house-edge multiplier sign is inverted: it *boosts* payout instead of reducing it. RTP is broken.
- 🐛 **`src/rng.ts` `weightedPick`**: `Math.random()` used as the RNG source in a function whose own docstring says *"suitable for gaming RNG applications"*.
- ♻️ **`src/types.ts` `LegacySpinResult`**: exported, imported by 0 files.
- 📋 **`src/engine.ts` `checkLine`** ⇄ **`src/paytable.ts` `lineWins`**: semantically identical (RAG cosine 0.852): same WILD-skip, same consecutive-match loop, different names. A textual diff would never see it.
- 🏗️ **`src/engine.ts` `EngineContainer`**: bespoke IoC container backed by a stringly-typed `Map<string, unknown>`, holding three values.

**One command. Full codebase. Evidence-backed findings. No code modified.**

Languages: TypeScript, Python, Rust, Go, Java, C#, Bash, SQL, YAML, JSON.

---

## Who runs Anatoly

| If you are… | You use Anatoly to… |
|---|---|
| **A senior dev or tech lead** shipping AI-generated code | Surface the duplicates, dead code, and silent bugs your AI tools left behind. |
| **A team on a Claude or Cursor subscription** | Get Opus-grade deliberation on every audit, at **$0 per token**. |
| **A regulated org** (finance, health, defense) | Audit **air-gapped**: embeddings local, LLM-optional local, **no source byte leaves your network**. |
| **An M&A or legal expert** doing tech due diligence | Produce reports that **survive counter-expertise**: every claim pinned to file, line, and evidence. |
| **A DevOps team** running CI/CD quality gates | Audit every PR with structured JSON output for your pipeline. |

---

## Why the findings hold up

- **Evidence-backed**: every finding is grep'd, read, and cross-referenced before it's reported. No hallucinated issues.
- **Semantic duplicate detection**: finds functions that *do the same thing* even when they look nothing alike.
- **Deliberation pass**: multi-LLM arbitration on disputed findings.
- **$0 on unchanged code**: SHA-256 cache. Re-running on a clean repo costs nothing.
- **Run and walk away**: Telegram when done. Watch mode and Claude Code hook for write → audit → fix loops.
- **Local by default**: embeddings run on your machine. With Claude Code subscription, no API key needed.

> Fair warning: this is context-and-time-hungry by design. Dream-quality code doesn't come cheap. It takes serious effort (and tokens) to get there.

---

## Measured accuracy

Anatoly is benchmarked against [anatoly-bench](https://github.com/r-via/anatoly-bench): fixtures seeded with curated defects (bugs, dead code, semantic duplicates, over-engineering) and scored by F1 against a ground-truth catalog.

```mermaid
xychart-beta
    title "slot-engine fixture, global F1 (%) per bench run"
    x-axis [v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, v16, v17, v18, v19, v20, v21, v22, v23, v24, v25, v26, v27, v28, v29, v30, v31, v32, v33, v34, v35, v36, v37, v37b, v38, v39, v40, v41, v42, v43, v44, v45, v46, v47, v47b, v48, v49, v50, v50b, v51, v52, v52b, v53, v54, v56, v57, v58, v59, v60, v61, v62, v63, v64, v65, v66, v67]
    y-axis "F1 (%)" 0 --> 100
    line [40.7, 43.2, 46.8, 43.5, 56.8, 65.5, 62.7, 61.0, 65.0, 57.8, 67.8, 63.8, 72.9, 64.2, 69.9, 65.5, 71.4, 69.7, 67.0, 66.2, 69.4, 68.8, 68.7, 67.8, 58.3, 56.2, 67.3, 71.5, 57.9, 62.1, 71.6, 57.5, 71.5, 70.4, 74.3, 65.8, 70.2, 72.2, 67.9, 67.6, 68.0, 76.5, 72.3, 62.8, 74.6, 75.5, 70.1, 75.5, 62.8, 70.9, 69.7, 75.8, 78.3, 73.2, 79.5, 76.3, 73.5, 76.8, 61.4, 73.2, 70.9, 69.5, 66.0, 69.9, 66.9, 72.9, 69.9, 75.1, 68.6]
```

The fixture (27 seeded defects) has been frozen since v16, so every later point is Anatoly behaviour plus run-to-run LLM variance (about 9 points on a single run). Best run: 79.5% (v52b). The last twelve points are the move to the Claude 5.5 generation shipped in 0.11.0: at equal reasoning effort and after the prompt recalibration, Sonnet 5.5 scores 69.9% and 75.1% (v65, v66), on par with the Sonnet 4.6 controls of the same day (72.3% mean) at about 40% of the cost and half the wall time.

Per-axis curves, change-log, and remaining misses: [slot-engine results](https://github.com/r-via/anatoly-bench/blob/main/docs/02-slot-engine-results.md).

---

## Getting started

```bash
# One-off run
npx @r-via/anatoly@latest run

# Or install globally
npm install -g @r-via/anatoly
anatoly run
```

**Prerequisites:** Node.js >= 20.19, plus one LLM auth path:

- **Claude Code subscription** (default): no API key needed
- **BYOK**: `ANTHROPIC_API_KEY`, etc.
- **Local**: Ollama, LM Studio, vLLM

**Default models** (since 0.11.0): Claude Sonnet 5.5 for the review axes, Haiku 5.5 for the mechanical ones, Opus 5.5 for deliberation, every call at `high` reasoning effort. Models and effort are set per tier in `.anatoly.yml`.

See [Installation](docs/01-Getting-Started/01-Installation.md) and [Recommended LLM Setup](docs/01-Getting-Started/03-Recommended-LLM-Setup.md).

### Optional: GPU embeddings

For better duplication detection, set up GGUF mode (Docker + NVIDIA GPU ≥ 12 GB VRAM):

```bash
npx anatoly local-embeddings upgrade
```

---

## Common commands

```bash
npx anatoly run                # Full audit
npx anatoly watch              # Daemon: incremental re-audit on change
npx anatoly estimate           # Forecast tokens, cost, time (no API calls)
npx anatoly runs attach        # Inspect a run (live or finished)
npx anatoly reset              # Wipe all state
```

> Full CLI: [docs/03-CLI-Reference/](docs/03-CLI-Reference/01-Commands.md). Configuration: [docs/01-Getting-Started/02-Configuration.md](docs/01-Getting-Started/02-Configuration.md).

---

## Documentation

| Section | Highlights |
|---------|------------|
| [Getting Started](docs/01-Getting-Started/) | [Vision](docs/01-Getting-Started/00-Vision.md), [Installation](docs/01-Getting-Started/01-Installation.md), [Configuration](docs/01-Getting-Started/02-Configuration.md) |
| [Architecture](docs/02-Architecture/) | [Pipeline](docs/02-Architecture/01-Pipeline-Overview.md), [7-Axis System](docs/02-Architecture/02-Seven-Axis-System.md), [RAG Engine](docs/02-Architecture/03-RAG-Engine.md), [Deliberation](docs/02-Architecture/05-Deliberation-Pass.md) |
| [CLI Reference](docs/03-CLI-Reference/) | [Commands](docs/03-CLI-Reference/01-Commands.md), [Global Options](docs/03-CLI-Reference/02-Global-Options.md) |
| [Integration](docs/05-Integration/) | [Claude Code Hooks](docs/05-Integration/01-Claude-Code-Hooks.md), [CI/CD](docs/05-Integration/02-CI-CD.md), [Watch Mode](docs/05-Integration/03-Watch-Mode.md), [Telegram](docs/05-Integration/04-Telegram-Notifications.md) |
| [Design Decisions](docs/07-Design-Decisions/) | [Why Local RAG](docs/07-Design-Decisions/01-Why-Local-RAG.md), [Evidence-Based](docs/07-Design-Decisions/02-Evidence-Based-Approach.md) |

---

## Development

```bash
git clone https://github.com/r-via/anatoly.git
cd anatoly
npm install
npm run dev        # Run with tsx
npm run build      # Build with tsup
npm test           # Vitest
npm run typecheck  # tsc --noEmit
```

## Contributing

1. Fork, branch (`feat/my-feature`)
2. `npm test && npm run typecheck`
3. Open a PR

By contributing, you agree to the [Contributor License Agreement](CLA.md) (Anatoly uses dual licensing: AGPL-3.0 + commercial).

## License

Dual-licensed:

- **Open source**: [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0). Free for open source, personal, and academic use.
- **Commercial**: proprietary license available. See [COMMERCIAL.md](COMMERCIAL.md).

## Contact

- Website: [anatoly.cloud](https://anatoly.cloud/)
- Issues: [github.com/r-via/anatoly/issues](https://github.com/r-via/anatoly/issues)

<!-- checked-by-anatoly -->
[![Checked by Anatoly](https://img.shields.io/badge/checked%20by-Anatoly-blue)](https://github.com/r-via/anatoly)
<!-- /checked-by-anatoly -->
