# Analysis Axes

Anatoly evaluates TypeScript code across **6 independent axes**, each running as a separate LLM evaluation pass. Results are merged using inter-axis coherence rules and optionally refined through an Opus deliberation pass.

## Table of Contents

- [Overview](#overview)
- [1. Utility](#1-utility)
- [2. Duplication](#2-duplication)
- [3. Correction](#3-correction)
- [4. Overengineering](#4-overengineering)
- [5. Tests](#5-tests)
- [6. Best Practices](#6-best-practices)
  - [The 17 Rules](#the-17-rules)
  - [Scoring System](#scoring-system)
  - [Context-Adapted Rules](#context-adapted-rules)
- [Verdict Computation](#verdict-computation)
- [Inter-Axis Coherence](#inter-axis-coherence)
- [Deliberation Pass](#deliberation-pass)

---

## Overview

| Axis | Model | Evaluates | Verdicts | Level |
|------|-------|-----------|----------|-------|
| Utility | haiku | Dead/unused code | `USED` · `DEAD` · `LOW_VALUE` | Per-symbol |
| Duplication | haiku | Semantic duplication via RAG | `UNIQUE` · `DUPLICATE` | Per-symbol |
| Correction | sonnet | Bugs & logic errors | `OK` · `NEEDS_FIX` · `ERROR` | Per-symbol |
| Overengineering | haiku | Unnecessary complexity | `LEAN` · `OVER` · `ACCEPTABLE` | Per-symbol |
| Tests | haiku | Test coverage quality | `GOOD` · `WEAK` · `NONE` | Per-symbol |
| Best Practices | sonnet | 17 TypeGuard v2 rules | `PASS` · `WARN` · `FAIL` per rule, score 0-10 | File-level |

**Execution order:** Utility, Duplication, Correction, Overengineering, Tests, Best Practices.

Axes 1-5 produce **per-symbol** results (each function, class, type, etc. gets its own verdict). Axis 6 produces **file-level** results with a score and per-rule evaluation.

Each symbol result includes a **confidence** score (0-100). Only symbols with confidence >= 60 contribute to the final verdict.

---

## 1. Utility

**What it evaluates:** Whether each symbol is actually used in the codebase or is dead/redundant code.

| Verdict | Meaning |
|---------|---------|
| `USED` | Symbol is imported or called by other code |
| `DEAD` | Symbol is never imported or used anywhere |
| `LOW_VALUE` | Symbol is used but provides negligible value (trivial wrapper, identity function) |

**How it works:**

Utility uses pre-computed import analysis from the usage graph — not guesswork. For each exported symbol, the evaluator receives:

- Number of runtime importers (files that `import { X }`)
- Number of type-only importers (files that `import type { X }`)
- File paths of all importers

**Key rules:**

- Exported symbol with >= 1 runtime importer = `USED` (confidence 95)
- Exported symbol with 0 runtime importers AND 0 type-only importers = `DEAD` (confidence 95)
- Exported symbol with 0 runtime importers but >= 1 type-only importer = `USED` (confidence 95) — type-only imports are real usage
- Non-exported symbols: evaluated by local usage within the file

---

## 2. Duplication

**What it evaluates:** Whether a symbol duplicates logic already present elsewhere in the codebase.

| Verdict | Meaning |
|---------|---------|
| `UNIQUE` | No semantic duplicate found |
| `DUPLICATE` | Symbol duplicates another function |

**How it works:**

Duplication uses the RAG semantic index (code embeddings via Jina v2 Base Code, 768-dim) to find similar functions across the codebase. When a candidate is found, both the source code of the symbol and the candidate (up to 50 lines) are presented for direct comparison.

**Similarity thresholds:**

| Score | Interpretation |
|-------|----------------|
| >= 0.82 | Likely duplicate — compare source to confirm |
| >= 0.68 | Similar code — evaluate if logic differs |
| < 0.68 | Sufficiently different |

When a symbol is marked `DUPLICATE`, the result includes a `duplicate_target` with the file path, symbol name, and similarity description.

---

## 3. Correction

**What it evaluates:** Bugs, logic errors, incorrect type usage, unsafe operations, and missing error handling.

| Verdict | Meaning |
|---------|---------|
| `OK` | No bugs or correctness issues found |
| `NEEDS_FIX` | Real bug or logic error causing incorrect runtime behavior |
| `ERROR` | Critical bug that would cause a crash or data loss |

**Two-pass verification:**

1. **Pass 1 — Standard evaluation:** LLM evaluates symbols for bugs
2. **Pass 2 — Verification (when findings exist):** Uses library README documentation to verify dependency-related findings, filtering false positives against official library behavior

**Correction memory:**

False positives are recorded in `.anatoly/correction-memory.json` and injected into future prompts to prevent recurrence.

**Actions:** Each `NEEDS_FIX` or `ERROR` generates actions with severity (`high` / `medium` / `low`) and fix descriptions. This is the only axis that produces actions (best practices produces suggestions instead).

---

## 4. Overengineering

**What it evaluates:** Unnecessary complexity, premature abstractions, and overly complex patterns.

| Verdict | Meaning |
|---------|---------|
| `LEAN` | Implementation is minimal and appropriate |
| `OVER` | Unnecessarily complex or uses premature abstraction |
| `ACCEPTABLE` | Some complexity but justified by requirements |

**Anti-patterns detected:**

- Unnecessary generics
- Factory patterns for single use
- Deep inheritance hierarchies
- Abstract classes with single implementation
- Excessive configuration for simple behavior

**Project structure signals:** The evaluator receives a project tree to detect fragmentation patterns (e.g., directory with only 1 file, >5 nesting levels, factory/adapter directories with <= 2 files).

---

## 5. Tests

**What it evaluates:** Test coverage quality — not just coverage percentage, but actual test meaningfulness.

| Verdict | Meaning |
|---------|---------|
| `GOOD` | Meaningful tests covering happy path and edge cases |
| `WEAK` | Tests exist but are superficial, missing edge cases, or testing implementation details |
| `NONE` | No test file or test cases found |

**Special cases:**

- Types, interfaces, and enums with no runtime behavior = `GOOD` by default (confidence 95)
- Coverage data (statements, branches, functions, lines) is provided as a signal but the LLM evaluates actual test quality, not just percentages

---

## 6. Best Practices

Best Practices is **file-level** (not per-symbol). It evaluates the entire file against 17 TypeGuard v2 rules and produces a score from 0 to 10.

### The 17 Rules

| # | Rule | Severity | Penalty | Description |
|---|------|----------|---------|-------------|
| 1 | Strict mode | HAUTE | -1 pt | `tsconfig.json` has `strict: true` |
| 2 | No `any` | CRITIQUE | -3 pts | No explicit or implicit `any` types |
| 3 | Discriminated unions | MOYENNE | -0.5 pt | Prefer tagged unions over type assertions |
| 4 | Utility types | MOYENNE | -0.5 pt | Uses Pick, Omit, Partial, Required, Record appropriately |
| 5 | Immutability | MOYENNE | -0.5 pt | Uses `readonly` and `as const` where appropriate |
| 6 | Interface vs Type | MOYENNE | -0.5 pt | Consistent convention within project |
| 7 | File size | HAUTE | -1 pt | Files < 300 lines preferred, 300-500 = WARN, >500 = FAIL |
| 8 | ESLint compliance | HAUTE | -1 pt | No obvious lint violations |
| 9 | JSDoc on public exports | MOYENNE | -0.5 pt | Public exports documented (always PASS for test files) |
| 10 | Modern 2026 practices | MOYENNE | -0.5 pt | No deprecated APIs, modern TypeScript 5.5+ syntax |
| 11 | Import organization | MOYENNE | -0.5 pt | Grouped imports, no circular dependencies, no side-effect imports |
| 12 | Async/Error handling | HAUTE | -1 pt | Proper error handling, no unhandled rejections (framework-aware) |
| 13 | Security | CRITIQUE | -4 pts | No hardcoded secrets, no eval, no command injection |
| 14 | Performance | MOYENNE | -0.5 pt | No obvious N+1, unnecessary re-renders, sync I/O in async |
| 15 | Testability | MOYENNE | -0.5 pt | Dependency injection, low coupling, pure functions (always PASS for test files) |
| 16 | TypeScript 5.5+ features | MOYENNE | -0.5 pt | Uses `satisfies`, const type params, `using` where appropriate |
| 17 | Context-adapted rules | MOYENNE | -0.5 pt | React/API/Utility-specific best practices |

Each rule outputs a status: `PASS` (satisfied), `WARN` (minor issues), `FAIL` (clear violation).

### Scoring System

1. Start at **10.0 points**
2. Subtract penalties per rule violation (WARN uses half penalty, FAIL uses full penalty)
3. Score cannot go below 0

**Example:** File with Rule 2 FAIL (-3), Rule 12 WARN (-0.5), Rule 13 FAIL (-4) = **2.5/10**

### Context-Adapted Rules

Rule 17 adapts its evaluation based on detected file context:

| Context | Detection | Specific checks |
|---------|-----------|-----------------|
| `react-component` | `.tsx` files, React imports | Proper hooks usage, avoid inline renders, prop drilling |
| `api-handler` | route/controller/handler in path | Request validation, error formatting, status codes |
| `utility` | util/helper/lib in path | Pure functions, no side effects, single responsibility |
| `test` | `.test.` or `.spec.` in filename | Descriptive names, arrange-act-assert, no logic in tests |
| `config` | config in path, `.config.ts` | Type safety, no runtime mutations |
| `general` | Default fallback | Standard TypeScript best practices |

**Dependency awareness:** Rule evaluations account for installed library versions. For example, Commander.js v7+ handles async rejections natively, so missing try-catch in an action handler is not a FAIL for Rule 12.

---

## Verdict Computation

After all 6 axes complete, results are merged into a final file-level verdict:

| Verdict | Meaning | Condition |
|---------|---------|-----------|
| `CLEAN` | No significant findings | No symbols with findings above confidence threshold |
| `NEEDS_REFACTOR` | Has findings worth addressing | Any symbol has `DEAD`, `DUPLICATE`, `OVER`, or `NEEDS_FIX` with confidence >= 60 |
| `CRITICAL` | Has critical bugs | Any symbol has `ERROR` with confidence >= 60 |

**Confidence threshold:** Only symbols with confidence >= 60 affect the verdict. Lower-confidence findings appear in the review but don't change the verdict.

**Priority:** `CRITICAL` > `NEEDS_REFACTOR` > `CLEAN` — if any symbol triggers a higher severity, that becomes the file verdict.

---

## Inter-Axis Coherence

After merging, these rules enforce logical consistency:

| Rule | Condition | Effect |
|------|-----------|--------|
| Dead code needs no tests | `utility = DEAD` | Force `tests = NONE` |
| ERROR makes complexity secondary | `correction = ERROR` | Force `overengineering = ACCEPTABLE` |
| Best practices confirms async safety | `correction = NEEDS_FIX` on async + Rule 12 = PASS | Downgrade correction confidence to max 55% (excluded from verdict) |

---

## Deliberation Pass

When `--deliberation` is enabled, a senior model (default: `claude-opus-4-6`) performs a final validation after merging.

**When deliberation runs:**

- Any symbol has `correction = NEEDS_FIX` or `ERROR`
- Any symbol has `utility = DEAD`, `duplication = DUPLICATE`, or `overengineering = OVER`
- Verdict is `CLEAN` but any symbol has `confidence < 70`

**When deliberation is skipped:**

- Verdict is `CLEAN` and all confidences >= 70 (no ambiguity to resolve)

**What deliberation does:**

1. Verifies inter-axis coherence
2. Filters residual false positives (reclassifies `NEEDS_FIX` -> `OK` when incorrect)
3. Protects confirmed `ERROR` findings (downgrade only with >= 95 confidence)
4. Adjusts confidences based on cross-axis evidence
5. Removes invalidated actions
6. Recomputes the final verdict

**Strict rules:**

- Cannot add new findings or symbols — only modify existing ones
- Cannot add new actions — only remove existing ones
- `ERROR` -> other reclassification requires deliberated confidence >= 95
- Other reclassifications require deliberated confidence >= 85

---

See also: [How It Works](how-it-works.md) · [Configuration](configuration.md) · [Output Formats](output-formats.md)
