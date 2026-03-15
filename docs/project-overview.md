# Anatoly -- Project Overview

**Version:** 0.4.2 | **License:** Apache-2.0 | **Runtime:** Node.js >= 20.19

---

## What is Anatoly?

Anatoly is an autonomous AI audit agent for TypeScript codebases. It walks through every file in a project, investigates it with full project context and a local semantic vector index, and delivers a surgical audit report where every finding is backed by evidence.

Anatoly is not a linter. It is not a static analysis rule set. It is a Claude agent with read access to the entire codebase and a semantic RAG index. The agent can grep for usages across the project, read other files to verify dead code, query similar functions via vector search, and cross-reference exports, imports, and test coverage. It must prove each finding with evidence before reporting it.

**One command. Full codebase. Evidence-backed findings. No code modified.**

```bash
npx anatoly run
```

---

## Core Value Proposition

TypeScript codebases accumulate technical debt fast, especially when AI-assisted coding tools generate large volumes of code. Dead code, hidden duplication, over-engineered abstractions, and missing test coverage silently degrade maintainability.

Traditional linters catch syntax issues but miss architectural rot. Manual code review does not scale. No existing tool can answer "is this function actually used anywhere?" with certainty, because that requires understanding the whole project, not just one file.

Anatoly closes this gap by combining AST parsing, agentic AI investigation, and local RAG into a single autonomous pipeline that produces evidence-backed findings at the symbol level.

---

## The 8-Phase Pipeline

| Phase | Name | Description |
|-------|------|-------------|
| 1 | **Scan** | Parses every file with tree-sitter to extract symbols (functions, classes, types, hooks, constants) with line ranges and export status. |
| 2 | **Estimate** | Counts tokens locally with tiktoken so the cost is known before any API call is made. |
| 3 | **Triage** | Classifies files into `skip` (barrels, type-only, constants) or `evaluate` (all other files), eliminating unnecessary API calls at zero cost. |
| 4 | **Usage Graph** | Pre-computes an import graph across all files in a single local pass (under 1 second), eliminating approximately 90% of redundant tool calls during review. |
| 5 | **Index (RAG)** | Builds a semantic vector index using local embeddings (Jina Embeddings V2 Base Code, 768-dim) stored in LanceDB. Zero API cost for RAG indexing. |
| 6 | **Review** | Launches a Claude agent per file with read-only tools (Glob, Grep, Read, findSimilarFunctions). All non-skipped files go through the same 6 parallel axis evaluators. The agent must prove every finding. |
| 7 | **Deliberate** | An optional Opus deliberation pass validates merged findings across axes, filters residual false positives, and ensures inter-axis coherence. |
| 8 | **Report** | Aggregates all Zod-validated reviews into a sharded audit report: compact index plus per-shard detail files (max 10 files each), sorted by severity, with symbol-level detail tables. |

---

## The 6-Axis Evaluation System

Every file is evaluated independently along six axes, which run in parallel:

| Axis | What It Measures |
|------|-----------------|
| **Utility** | Is the symbol actually used? Detects dead code, unreferenced exports, and unused internal functions by analyzing the pre-computed usage graph and grepping across the project. |
| **Duplication** | Does similar logic exist elsewhere? Uses RAG vector similarity to detect cross-file duplicates invisible to grep, including renamed variables and refactored patterns. |
| **Correction** | Are there bugs or incorrect patterns? Runs a two-pass pipeline: standard analysis followed by verification against actual dependency README documentation from node_modules, preventing false positives from library-specific patterns. |
| **Overengineering** | Is the code unnecessarily complex? Flags abstractions, indirection layers, and design patterns that add complexity without proportional benefit. |
| **Tests** | Is the symbol adequately tested? Cross-references test files, coverage patterns, and assertion quality. |
| **Best Practices** | Does the code follow established conventions? Evaluates async/error handling, type safety, naming, and structural patterns. |

Each axis runs independently per file. If one axis crashes, the others continue. The merger injects crash sentinels for failed axes and computes the final verdict from the surviving axes only.

---

## Key Technologies

| Technology | Role |
|------------|------|
| **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | Powers the agentic review loop; each file gets its own agent session with read-only tools. |
| **web-tree-sitter** + **tree-sitter-typescript** | AST parsing to extract symbols, line ranges, and export status from every file. |
| **Xenova Transformers** (`@xenova/transformers`) | Local embedding computation using Jina Embeddings V2 Base Code (768-dim vectors), zero API cost. |
| **LanceDB** (`@lancedb/lancedb`) | Local vector database for the semantic RAG index, enabling cross-file duplication detection. |
| **tiktoken** | Local token counting for cost estimation before any API call. |
| **Zod** | Strict schema validation for all agent outputs, with an agent-schema feedback loop for self-correction. |
| **Commander** | CLI framework providing the `run`, `watch`, `scan`, `estimate`, `review`, `report`, and other commands. |
| **chokidar** | File system watcher powering daemon/watch mode for incremental re-review on file changes. |

---

## Target Users

- **Senior developers and Tech Leads** working in TypeScript, React, and Node.js
- **Teams producing large volumes of AI-generated code** with tools like Claude Code, Cursor, or Windsurf
- **Projects ranging from 20 to 1,000+ TypeScript files** where manual review does not scale

---

## Key Innovations

- **Evidence-backed findings** -- The agent must prove every finding by grepping, reading, and cross-referencing before reporting. No guessing.
- **AST-driven scanning** -- tree-sitter extracts every symbol with line ranges and export status, giving the agent structural awareness beyond raw text.
- **Local RAG with zero API cost** -- Embeddings are computed locally with Jina V2 Base Code and stored in LanceDB. Semantic duplication detection runs entirely on the local machine.
- **Crash-resilient axis pipeline** -- Six axes run independently per file. A crash in one axis does not affect the others; sentinels mark failures transparently.
- **Sharded reports** -- A compact index file plus per-shard detail files (max 10 files each) keep reports navigable even on large codebases.
- **Two-pass correction with dependency verification** -- Findings are re-evaluated against actual library documentation from node_modules, preventing false positives from framework-specific patterns.
- **Correction memory** -- A persistent false-positive registry (`.anatoly/correction-memory.json`) prevents repeated flags across runs.
- **Smart caching** -- SHA-256 per file; unchanged files skip review at zero API cost on subsequent runs.
- **Claude Code integration** -- PostToolUse and Stop hooks create a real-time write-audit-fix loop with anti-loop protection.

---

## Links

- Repository: [github.com/r-via/anatoly](https://github.com/r-via/anatoly)
- Issues: [github.com/r-via/anatoly/issues](https://github.com/r-via/anatoly/issues)
