<p align="center">
  <img src="assets/imgs/logo.jpg" alt="Anatoly"/>
</p>

# Anatoly

*"Can I clean here?"*

**The AI agent that deep-audits your codebase, and proves every finding.**

Named after [a certain cleaning man](https://www.youtube.com/@vladimirfitness) who politely asks *"Can I clean here?"* — then deadlifts the entire rack.

[![Website](https://img.shields.io/badge/website-anatoly.cloud-1f6feb)](https://anatoly.cloud/) [![Node.js](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

```bash
npx @r-via/anatoly@latest run   # one command, full codebase audit
```

---

## What is Anatoly?

<p align="center">
  <img src="assets/anims/demo.gif" alt="Anatoly demo"/>
</p>

You run one command. A few minutes later, you get a report like this:

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

**One command. Full codebase. Evidence-backed findings. No code modified.**

Languages: TypeScript, Python, Rust, Go, Java, C#, Bash, SQL, YAML, JSON.

---

## Who it's for

Senior developers, Tech Leads, and teams shipping large amounts of AI-generated code (Claude Code, Cursor, Windsurf). Designed for projects from 20 to 1,000+ source files.

## What you get

- **Evidence-backed** — every finding is grep'd, read, and cross-referenced before it's reported. No hallucinated issues.
- **Semantic duplicate detection** — finds functions that *do the same thing* even when they look nothing alike.
- **$0 on unchanged code** — SHA-256 cache. Re-running on a clean repo costs nothing.
- **Run and walk away** — Telegram notification when done. Optional `watch` mode and Claude Code hook for write→audit→fix loops.
- **Multi-language** — auto-detected, AST-parsed.
- **Local by default** — embeddings run on your machine. With Claude Code subscription, no API key needed.

> Fair warning: this is context-and-time-hungry by design. Dream-quality code doesn't come cheap — it takes serious effort (and tokens) to get there.

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

- **Claude Code subscription** (default) — no API key needed
- **Gemini CLI** — Google OAuth, $0/token
- **BYOK** — `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.
- **Local** — Ollama, LM Studio, vLLM

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
npx anatoly estimate           # Forecast tokens, cost, time — no API calls
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

- **Open source** — [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0): free for open source, personal, and academic use.
- **Commercial** — proprietary license available. See [COMMERCIAL.md](COMMERCIAL.md).

## Contact

- Website: [anatoly.cloud](https://anatoly.cloud/)
- Issues: [github.com/r-via/anatoly/issues](https://github.com/r-via/anatoly/issues)

<!-- checked-by-anatoly -->
[![Checked by Anatoly](https://img.shields.io/badge/checked%20by-Anatoly-blue)](https://github.com/r-via/anatoly)
<!-- /checked-by-anatoly -->
