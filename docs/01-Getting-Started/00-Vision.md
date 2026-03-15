# Vision

## "Can I clean here?"

Anatoly is named after the meticulous custodian who never touches a surface without asking first. The slogan captures the agent's core principle: **observe everything, prove before reporting, modify nothing**. Anatoly reads your entire codebase, investigates every symbol with full project context, and delivers a surgical audit report -- but it never changes a single line of your code.

## Mission

Anatoly exists to solve a problem that linters and static analysis cannot: **architectural rot in TypeScript codebases**.

Traditional tools catch syntax violations and stylistic inconsistencies. They operate on individual files with pattern-matching rules. They cannot answer questions like:

- Is this exported function actually imported anywhere in the project?
- Are these two utility functions in different modules doing the same thing with renamed variables?
- Is this abstraction layer justified, or was it over-engineered for a single call site?
- Does this file have any test coverage at all?

These questions require understanding the **whole project** -- its import graph, its semantic structure, its test surface. Anatoly is a Claude agent with read access to every file in the codebase, a pre-computed usage graph, and a local semantic vector index. It can grep for usages, read other files to verify dead code, query a RAG index to surface semantically similar functions, and cross-reference exports, imports, and test coverage.

Every finding must be **proven with evidence** before it appears in the report. No heuristic guesses. No pattern-matching false positives. The agent must show its work.

## Philosophy: Evidence-backed auditing, not linting

Anatoly is not a linter. It is not a rule engine. It does not enforce a style guide.

Anatoly is an **autonomous audit agent** that conducts a structured investigation across six axes:

| Axis | What it investigates |
|------|---------------------|
| **Correction** | Bugs, misuse of APIs, logical errors, incorrect types |
| **Overengineering** | Unnecessary abstractions, premature generalization, dead complexity |
| **Utility** | Dead code, unused exports, orphaned symbols |
| **Duplication** | Copy-paste patterns, semantic duplicates across files (via RAG) |
| **Tests** | Missing test coverage, untested edge cases |
| **Best practices** | TypeScript idioms, error handling, naming, performance |

Each axis runs independently with its own agent call. Findings are merged, deduplicated, and optionally passed through an Opus deliberation pass that detects inter-axis incoherence and filters residual false positives.

The result is a report that reads like a senior engineer's code review -- not a list of lint warnings.

## Target audience

Anatoly is built for:

- **Teams producing AI-assisted code.** Tools like Claude Code, Cursor, and Windsurf generate large volumes of code quickly. That velocity creates a gap between code production and code quality assurance. Anatoly closes that gap.
- **Senior developers and Tech Leads** who need to understand the health of a codebase without reading every file manually.
- **TypeScript/React/Node.js projects** from 20 to 1,000+ source files.

If your team ships fast and reviews later, Anatoly is the reviewer that never gets tired and never skims.

## Positioning

| Tool | Scope | Method | Findings |
|------|-------|--------|----------|
| **ESLint** | Single file | Pattern matching against rules | Style violations, simple bugs |
| **SonarQube** | Multi-file | Static analysis with rule database | Code smells, complexity metrics |
| **TypeScript compiler** | Type system | Type checking | Type errors |
| **Anatoly** | Whole project | Autonomous AI agent with RAG | Dead code, semantic duplication, over-engineering, missing tests, architectural issues |

ESLint tells you a variable is unused in one file. Anatoly tells you an entire module is dead because nothing imports it -- and proves it by showing the import graph. SonarQube flags cognitive complexity. Anatoly flags an abstraction layer that exists to serve a single call site and recommends inlining it. The TypeScript compiler catches type errors. Anatoly catches a function that technically type-checks but misuses a library API based on its documentation.

These tools are complementary. Anatoly is not a replacement for linting or type checking. It is the layer above: the deep audit that catches what automated rules cannot.
