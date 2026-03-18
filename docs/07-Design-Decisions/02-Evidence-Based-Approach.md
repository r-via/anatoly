# ADR-02: Evidence-Based Findings

**Status:** Accepted
**Date:** 2025-01-15
**Deciders:** Core team

## Context

False positives are the number one killer of audit tool adoption. A tool that flags 100 issues but gets 30 wrong trains developers to ignore it entirely. After a few bad experiences, the team stops reading the output and the tool becomes shelfware.

Traditional static analysis tools operate on pattern matching: they see a pattern that *could* be a problem and flag it. They have no mechanism to verify whether the pattern is actually problematic in the context of the full project. This is why ESLint's `no-unused-vars` flags a function that is re-exported through a barrel file, and why SonarQube flags "complexity" on functions that are genuinely complex by necessity.

Anatoly's core thesis is different: **every finding must include proof.** The agent does not report what *looks* wrong; it reports what it has *verified* is wrong.

## Decision

Require every axis evaluator to produce evidence-backed findings. The agent must investigate the codebase context before making a judgment, and every symbol-level result must include a `detail` field (minimum 10 characters, enforced by Zod validation) explaining the reasoning.

### How it works in practice

Anatoly's review pipeline operates on seven independent axes, each responsible for a specific dimension of code quality. Every axis evaluator follows the same evidence contract:

1. **Pre-computed context is injected into the prompt.** Rather than asking the LLM to "go look things up," Anatoly pre-computes the evidence and hands it to the model. The usage graph tells the utility axis exactly which files import each symbol. The RAG index tells the duplication axis which functions are semantically similar. Dependency metadata tells the correction axis which library versions are in use.

2. **The model evaluates against concrete evidence.** For example, the utility axis (`src/core/axes/utility.ts`) receives a "Pre-computed Import Analysis" section in its prompt that lists, for each exported symbol, exactly how many files import it and which ones. The model does not guess whether a function is used; it sees `imported by 3 files: src/core/runner.ts, src/commands/run.ts, src/commands/review.ts` or `imported by 0 files -- LIKELY DEAD`.

3. **Structured output with per-symbol confidence.** Every axis returns typed results validated by Zod schemas. Each symbol gets a verdict (e.g., USED/DEAD/LOW_VALUE for utility), a confidence score (0-100), and a detail string. The detail is not optional filler; it is the evidence trail that makes the finding actionable.

4. **Validation retry loop.** If the LLM output fails Zod validation (missing fields, confidence out of range, detail too short), the evaluator automatically retries once with the Zod error messages as feedback (`src/core/axis-evaluator.ts`, `runSingleTurnQuery`). This ensures the evidence contract is never silently violated.

### Two-pass correction

The correction axis (`src/core/axes/correction.ts`) goes further with a two-pass verification system specifically designed to eliminate false positives about library API usage:

**Pass 1** evaluates the file for bugs, logic errors, and correctness issues. It receives the source code, symbol list, and dependency versions.

**Pass 2** activates only when Pass 1 flags symbols as NEEDS_FIX or ERROR. It extracts keywords from the findings, uses them to pull targeted sections from the actual README files of the implicated npm packages (`node_modules/<package>/README.md`), and asks the model to re-evaluate each finding against the documentation.

The verification pass can:
- **Confirm** a finding (keep the verdict, possibly adjust confidence).
- **Overturn** a finding (change NEEDS_FIX to OK, citing the specific documentation section).
- **Lower confidence** when documentation is ambiguous.

When a finding is overturned, it is recorded in a **correction memory** file (`.anatoly/correction-memory.json`) so that the same false positive pattern is not repeated in future runs. This memory is injected into Pass 1 prompts as known false positives, creating a learning loop.

### Axis-level evidence requirements

| Axis | Evidence source | What the model receives |
|---|---|---|
| **Utility** | Usage graph (`src/core/usage-graph.ts`) | Per-symbol import counts with file paths; distinguishes runtime vs. type-only imports |
| **Duplication** | RAG vector search (`src/rag/`) | Top-N semantically similar functions with signatures, complexity scores, and source snippets (up to 50 lines each) |
| **Correction** | Dependency metadata + README verification | Library versions from package.json; targeted README sections from node_modules in Pass 2 |
| **Overengineering** | File content + symbol metadata | Full source with AST-extracted symbol boundaries, export status, and kind classification |
| **Tests** | File content + project structure | Source code with symbol list; test file co-location patterns |
| **Best practices** | File content + project tree | Source code with full project directory tree for import pattern analysis |

## Consequences

### Positive

- **Actionable output.** Every finding includes enough context for a developer to understand *why* it was flagged and make an informed decision. No "this might be unused" without proof.
- **High trust.** The two-pass correction system with documentation verification catches the most damaging class of false positives: incorrect claims about library API misuse.
- **Learning system.** Correction memory prevents the same false positive from recurring, so accuracy improves over repeated runs.
- **Auditable.** Full transcripts of every LLM interaction are stored per-axis. A skeptical developer can read exactly what the model saw and what it concluded.

### Negative

- **Higher token cost.** Pre-computing and injecting evidence (usage graph data, RAG results, README sections) increases prompt size. The two-pass correction doubles the cost of the correction axis when findings are present.
- **Slower execution.** The verification pass adds latency when bugs are detected. This is a deliberate trade-off: it is better to be slow and correct than fast and wrong.
- **Minimum detail length can produce verbose output.** The 10-character minimum on detail strings is low, but even this floor prevents empty or single-word explanations. Some axis responses include more detail than strictly necessary.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| **Tool-use agent (grep/read during evaluation)** | Letting the LLM decide what to investigate at runtime is non-deterministic: it might skip verification, use wrong grep patterns, or waste tokens on irrelevant reads. Pre-computing evidence is more reliable and reproducible. |
| **Single-pass correction (no verification)** | Early testing showed unacceptable false positive rates on library API usage. The LLM confidently flags patterns it thinks are bugs because it does not know about library-specific behavior (e.g., LanceDB's distance semantics, Zod's `.int()` method). |
| **Confidence threshold filtering only** | Filtering by confidence alone (e.g., drop findings below 70%) does not work because the LLM's self-reported confidence is poorly calibrated. A model will report 85% confidence on a finding that is completely wrong because it does not know what it does not know. Evidence-based verification is more reliable than confidence scores. |
