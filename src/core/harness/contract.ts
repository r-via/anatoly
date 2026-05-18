// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * The `harness/` bounded context: the published language of the unit harness
 * (doc 14 §3/§4).
 *
 * This is the **shared kernel** for the execution-unit SPI. It depends on
 * nothing in `core/` (the only type it names, `AbortController`, is a
 * global), so every agent-hosting context can import it cycle-free:
 * `evaluation` (axes, single-turn), `documentation` (doc generation /
 * coherence), `refinement`, and `orchestration` (the phase grain, PR 4).
 *
 * doc 14 PR 3a relocated `ExecutionUnit` / `HarnessCtx` here from
 * `evaluation/contract.ts`. PR 2a had placed them in `evaluation/` to dodge
 * the orchestration<->evaluation cycle; that was locally correct but globally
 * insufficient: `documentation` (also an agent host) has a runtime edge with
 * `evaluation` (`file-evaluator -> documentation`), so it could not reach an
 * evaluation-hosted harness without `evaluation -> documentation ->
 * evaluation`. A dependency-free context is the only cycle-free home for a
 * "single harness every agent flows through". Pure type move: behaviour
 * unchanged.
 */

/**
 * The single central point of interaction the harness threads into every
 * unit. It carries cooperative cancellation **when the unit's boundary
 * exposes one** (the single-turn axes and refinement do; the doc generation
 * and coherence agents do not, so `abortController` is optional, doc 14 PR
 * 3c: a synthetic handle the agent never reads would be a lie, see the
 * PR-3b no-synthetic-handle principle). The sink, event emitter and cost
 * recorder land here in later PRs (doc 14 §4, §5). Kept minimal on purpose:
 * doc 14 §1 rejects a speculative generic surface.
 */
/**
 * doc 15 PR 2a: a unit's LLM/agent cost, in the exact shape
 * `orchestration/cost.ts recordLlmCost` consumes. Plain and zero-dependency
 * (no orchestration import) so `core/harness` stays the cycle-free shared
 * kernel; orchestration structurally satisfies it. Minimal cost-only
 * contract: NOT the full form-first PhaseEnvelope doc 14 declined (PR 4c).
 */
export interface UnitCostEntry {
  provider: 'anthropic' | 'gemini';
  /** the run-metrics phase bucket (e.g. 'review', 'rag-index', a doc taskId). */
  phase: string;
  /** axis bucket, when the unit is a single axis. */
  axis?: string;
  costUsd: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  calls?: number;
}

export interface HarnessCtx {
  readonly abortController?: AbortController;
  /**
   * doc 15 PR 2a: the injected cost sink. Orchestration wires this to
   * `recordLlmCost(ctx, ...)` (dependency inversion: the harness invokes it,
   * never imports orchestration). Optional: when absent, `runUnit` does not
   * fold cost (pre-PR-2a behaviour). Wired into every unit by PR 2b/2c so a
   * unit cannot omit reporting.
   */
  readonly recordCost?: (entry: UnitCostEntry) => void;
}

/**
 * doc 14 §3. A phase and an agent are two specializations of one unit. The
 * contract is deliberately narrow: identity (for event / cost attribution)
 * and a `run` taking typed input plus the harness context. The implementer
 * never touches cost / event / transcript / log plumbing: those belong to
 * the harness (doc 14 §4), which is the only sanctioned entry.
 */
export interface ExecutionUnit<I, O> {
  readonly name: string;
  run(input: I, h: HarnessCtx): Promise<O>;
  /**
   * doc 15 PR 2a: the unit declares how to read its own cost from its
   * result (cost fields are non-uniform across units: `costUsd` vs
   * `totalCostUsd` vs per-axis timing, so no envelope is forced). Optional:
   * a unit without it is not cost-captured by the harness (the pre-PR-2a
   * state). `runUnit` calls this and feeds {@link HarnessCtx.recordCost}.
   * Return `undefined` when there is nothing to record (no LLM ran).
   */
  cost?(output: O): UnitCostEntry | undefined;
}
