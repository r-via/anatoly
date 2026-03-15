# Anatoly - Documentation Index

> **Anatoly** v0.5.0 -- Autonomous AI audit agent for TypeScript codebases.
> Deep, evidence-backed code reviews powered by Claude AI and semantic RAG.
>
> License: Apache-2.0

---

## 1. Getting Started

| Document | Description |
|----------|-------------|
| [Vision](01-Getting-Started/00-Vision.md) | Mission, philosophy, and guiding principles |
| [Installation](01-Getting-Started/01-Installation.md) | Prerequisites, install steps, and first run |
| [Configuration](01-Getting-Started/02-Configuration.md) | Config files, environment variables, and tuning options |

---

## 2. Architecture

| Document | Description |
|----------|-------------|
| [Pipeline Overview](02-Architecture/01-Pipeline-Overview.md) | End-to-end audit pipeline: scan, estimate, triage, evaluate, report |
| [Six-Axis System](02-Architecture/02-Six-Axis-System.md) | The six evaluation axes (correctness, security, performance, etc.) |
| [RAG Engine](02-Architecture/03-RAG-Engine.md) | Semantic retrieval-augmented generation for evidence gathering |
| [Usage Graph](02-Architecture/04-Usage-Graph.md) | Dependency and usage graph construction |
| [Deliberation Pass](02-Architecture/05-Deliberation-Pass.md) | Multi-turn deliberation for confident findings |

---

## 3. CLI Reference

| Document | Description |
|----------|-------------|
| [Commands](03-CLI-Reference/01-Commands.md) | All CLI commands (`run`, `scan`, `review`, `hook init`, etc.) |
| [Global Options](03-CLI-Reference/02-Global-Options.md) | Flags and options shared across commands |
| [Output Formats](03-CLI-Reference/03-Output-Formats.md) | JSON, Markdown, and terminal output modes |

---

## 4. Core Modules

| Document | Description |
|----------|-------------|
| [Scanner](04-Core-Modules/01-Scanner.md) | File discovery, AST parsing, and scope extraction |
| [Estimator](04-Core-Modules/02-Estimator.md) | Complexity estimation and prioritization scoring |
| [Triage](04-Core-Modules/03-Triage.md) | Filtering and ranking files for review |
| [Axis Evaluators](04-Core-Modules/04-Axis-Evaluators.md) | Per-axis evaluation logic and prompt design |
| [Reporter](04-Core-Modules/05-Reporter.md) | Finding aggregation and report generation |
| [Worker Pool](04-Core-Modules/06-Worker-Pool.md) | Concurrent evaluation with rate-limit management |

---

## 5. Integration

| Document | Description |
|----------|-------------|
| [Claude Code Hooks](05-Integration/01-Claude-Code-Hooks.md) | Using Anatoly as a Claude Code hook |
| [CI/CD](05-Integration/02-CI-CD.md) | GitHub Actions, GitLab CI, and other pipeline integrations |
| [Watch Mode](05-Integration/03-Watch-Mode.md) | Continuous audit on file changes |

---

## 6. Development

| Document | Description |
|----------|-------------|
| [Source Tree](06-Development/00-Source-Tree.md) | Annotated source tree with module descriptions and LOC |
| [Contributing](06-Development/01-Contributing.md) | Development workflow, code style, and PR guidelines |
| [Testing](06-Development/02-Testing.md) | Test strategy, fixtures, and running the test suite |
| [Schemas](06-Development/03-Schemas.md) | Internal data schemas and type definitions |

---

## 7. Design Decisions

| Document | Description |
|----------|-------------|
| [Why Local RAG](07-Design-Decisions/01-Why-Local-RAG.md) | Rationale for local semantic search over external services |
| [Evidence-Based Approach](07-Design-Decisions/02-Evidence-Based-Approach.md) | Why every finding must cite concrete code evidence |
| [Cost Optimization](07-Design-Decisions/03-Cost-Optimization.md) | Strategies for minimizing token usage and API costs |
