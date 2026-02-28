# How Anatoly Works

Anatoly combines **tree-sitter AST parsing** with an **agentic AI review loop** powered by Claude Agent SDK. The pipeline works in eight phases:

1. **Scan** — Parses every file with tree-sitter to extract symbols (functions, classes, types, hooks, constants) with line ranges and export status
2. **Estimate** — Counts tokens locally with tiktoken so you know the cost before any API call
3. **Triage** — Classifies files into `skip` (barrels, type-only, constants), `fast` (simple files), or `deep` (complex files), eliminating unnecessary API calls
4. **Usage Graph** — Pre-computes an import graph across all files in a single local pass (< 1s), so the agent no longer needs to grep for usage verification
5. **Index** — Detects hardware (RAM, GPU), resolves embedding models, then builds a semantic RAG index. In **code-only mode**, embeds function bodies directly with Jina v2 (768d). In **dual mode**, also generates NLP summaries via Haiku and embeds them with MiniLM (384d) for hybrid search. See [RAG Pipeline](rag.md) for full details
6. **Review** — Launches a Claude agent per file with read-only tools (Glob, Grep, Read, findSimilarFunctions). Simple files get a fast single-turn review; complex files get the full agentic investigation. The agent must **prove** every finding before reporting it
7. **Deliberate** — An optional Opus deliberation pass validates merged findings across axes, filters residual false positives, and ensures inter-axis coherence before the final report
8. **Report** — Aggregates all Zod-validated reviews into a sharded audit report: compact index + per-shard detail files (max 10 files each), sorted by severity, with symbol-level detail tables

---

## Self-correction loop

The review phase includes an **agent ↔ schema feedback loop**. When the agent produces its JSON output, Anatoly validates it against a strict Zod schema. If validation fails, the exact Zod errors are sent back to the agent **within the same session**, preserving the full investigation context. The agent corrects its output and resubmits, up to `max_retries` times (default: 3).

## Two-pass correction with dependency verification

The Perfectionist (correction axis) runs a **two-pass pipeline** to eliminate false positives caused by library-specific patterns:

1. **Pass 1** — Standard correction analysis flags `NEEDS_FIX` and `ERROR` symbols
2. **Pass 2** — A verification agent re-evaluates each finding against the **actual README documentation** of the dependencies involved (read from `node_modules/`). If the library handles the flagged pattern natively, the finding is downgraded to `OK`

False positives are recorded in a **persistent correction memory** (`.anatoly/correction-memory.json`). On subsequent runs, known false positives are injected into the prompt so the agent avoids flagging them again. The memory deduplicates by pattern and dependency.

Additionally, a **contradiction detector** cross-references correction findings against best-practices results — for example, if best-practices confirms async/error handling is correct (Rule 12 PASS) but correction flags `NEEDS_FIX` on an async pattern, the confidence is automatically lowered below the reporting threshold.

## Crash-resilient axis pipeline

Each of the 6 axes runs independently per file. If one axis crashes, the others continue. The merger injects **crash sentinels** for failed axes (visible in `.rev.md` as "axis crashed — see transcript") and computes the final verdict from the surviving axes only.

## Opus deliberation pass

After all axes merge their results, an optional **deliberation pass** powered by Claude Opus validates the combined findings. The deliberation agent acts as a senior auditor:

1. **Coherence check** — Verifies inter-axis findings make sense together (e.g., a function can't be both `DEAD` and `DUPLICATE`)
2. **False-positive filter** — Re-evaluates `NEEDS_FIX` and `ERROR` findings; downgrades incorrect ones to `OK` (ERROR requires >= 95 confidence to downgrade)
3. **Confidence adjustment** — Adjusts symbol confidences based on cross-axis evidence
4. **Action cleanup** — Removes actions tied to invalidated findings

Enable with `llm.deliberation: true` in `.anatoly.yml`. Uses `claude-opus-4-6` by default (configurable via `llm.deliberation_model`). Skips files with high-confidence `CLEAN` verdicts to minimize cost.

## Project tree context

Axes that benefit from structural awareness (`best_practices`, `overengineering`) receive a compact ASCII tree of the project. The tree is automatically condensed to stay under 300 tokens, even on 500+ file projects, giving axes contextual understanding of project scope and organization.

## Claude Code autocorrection hook

Anatoly can plug directly into Claude Code as a **PostToolUse + Stop hook**, creating a real-time audit loop while Claude Code writes your code:

1. **Every time Claude Code edits a file**, the `PostToolUse` hook fires, Anatoly spawns a background review for that file (debounced, SHA-checked, non-blocking)
2. **When Claude Code finishes its task**, the `Stop` hook fires, Anatoly waits for pending reviews, collects all findings above `min_confidence`, and **blocks the stop with the findings as the reason**, forcing Claude Code to address them
3. **Claude Code sees the audit findings** and self-corrects, fixing dead code, removing duplication, simplifying over-engineered abstractions, before the user ever sees the result

The result is an **autonomous write → audit → fix loop**: Claude Code writes, Anatoly audits in real-time, Claude Code fixes. Anti-loop protection via Claude Code's native `stop_hook_active` flag prevents runaway iterations.

```bash
npx anatoly hook init   # generates .claude/settings.json hooks
```

Every finding is backed by evidence. Every review is schema-validated. The agent never guesses — it investigates.
