// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { get_encoding } from 'tiktoken';
import { TaskSchema, type Task } from '../schemas/task.js';
import { ALL_AXIS_IDS } from './axes/index.js';
import { calculateCost } from '../utils/cost-calculator.js';
import { estimateCalibratedMinutes, type CalibrationData } from './calibration.js';
import { NLP_TOKENS_PER_FUNCTION } from '../rag/embed-estimator.js';

const SYSTEM_PROMPT_TOKENS = 600;
const PER_FILE_OVERHEAD_TOKENS = 50;
const OUTPUT_TOKENS_PER_SYMBOL = 150;
const OUTPUT_BASE_PER_FILE = 300;

/**
 * Weighted time estimation constants (axis pipeline).
 * BASE_SECONDS covers fixed overhead (file read, prompt assembly, RAG pre-resolution).
 * SECONDS_PER_SYMBOL accounts for LLM output tokens scaling with symbol count.
 * A file with 5 symbols ≈ 8s, a file with 20 symbols ≈ 20s.
 */
export const BASE_SECONDS = 4;
export const SECONDS_PER_SYMBOL = 0.8;

/**
 * Concurrency does not scale linearly due to rate limits, API contention,
 * and tail effects (last workers finish alone). 0.75 = 25% overhead.
 */
export const CONCURRENCY_EFFICIENCY = 0.75;

/** Number of axis evaluators per file (derived from registry — single source of truth) */
export const AXIS_COUNT = ALL_AXIS_IDS.length;

/** Axes using haiku (cheaper/faster) vs sonnet (costlier/deeper) */
export const HAIKU_AXES = 5; // utility, duplication, overengineering, tests, documentation
export const SONNET_AXES = 2; // correction, best_practices

export interface EstimateResult {
  files: number;
  symbols: number;
  inputTokens: number;
  outputTokens: number;
  estimatedMinutes: number;
  /** Breakdown: estimated LLM calls (AXIS_COUNT per file × N files) */
  estimatedCalls: number;
}

/**
 * Compute the estimated seconds for a single file based on its symbol count.
 */
export function estimateFileSeconds(symbolCount: number): number {
  return BASE_SECONDS + symbolCount * SECONDS_PER_SYMBOL;
}

/**
 * Compute estimated seconds for a list of tasks (evaluate-tier only).
 */
export function estimateSequentialSeconds(tasks: Task[]): number {
  return tasks.reduce((sum, t) => sum + estimateFileSeconds(t.symbols.length), 0);
}

/**
 * Compute estimated minutes factoring in concurrency overhead.
 */
export function estimateMinutesWithConcurrency(sequentialSeconds: number, concurrency: number): number {
  if (sequentialSeconds === 0) return 0;
  const effectiveSeconds = concurrency > 1
    ? sequentialSeconds / (concurrency * CONCURRENCY_EFFICIENCY)
    : sequentialSeconds;
  return Math.ceil(effectiveSeconds / 60);
}

/**
 * Load all .task.json files from the tasks directory.
 */
export function loadTasks(projectRoot: string): Task[] {
  const tasksDir = resolve(projectRoot, '.anatoly', 'tasks');
  if (!existsSync(tasksDir)) return [];

  const entries = readdirSync(tasksDir).filter((f) => f.endsWith('.task.json'));
  const tasks: Task[] = [];

  for (const entry of entries) {
    try {
      const raw = readFileSync(join(tasksDir, entry), 'utf-8');
      tasks.push(TaskSchema.parse(JSON.parse(raw)));
    } catch {
      // Skip unreadable task files
    }
  }

  return tasks;
}

/**
 * Count tokens in a string using cl100k_base encoding (Claude-compatible).
 */
export function countTokens(text: string): number {
  const enc = get_encoding('cl100k_base');
  try {
    return enc.encode(text).length;
  } finally {
    enc.free();
  }
}

/**
 * Estimate token usage for a given set of tasks.
 * Reads actual file content to get accurate input token counts via
 * cl100k_base encoding. When a file cannot be read (e.g. deleted since
 * scan), falls back to a heuristic based on symbol line ranges
 * (`(line_end - line_start + 1) * 8` tokens per symbol).
 *
 * Token accounting per task:
 * - **input** = `SYSTEM_PROMPT_TOKENS` + actual file tokens + `PER_FILE_OVERHEAD_TOKENS`
 * - **output** = `OUTPUT_BASE_PER_FILE` + symbol count * `OUTPUT_TOKENS_PER_SYMBOL`
 *
 * @param projectRoot - Absolute path to the project root for resolving task file paths.
 * @param tasks - Array of scanned Task objects whose files will be token-counted.
 * @returns An object with `inputTokens` (estimated prompt tokens across all tasks),
 *   `outputTokens` (estimated completion tokens), and `symbols` (total symbol count).
 */
export function estimateTasksTokens(
  projectRoot: string,
  tasks: Task[],
): { inputTokens: number; outputTokens: number; symbols: number } {
  if (tasks.length === 0) return { inputTokens: 0, outputTokens: 0, symbols: 0 };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalSymbols = 0;

  const enc = get_encoding('cl100k_base');

  try {
    for (const task of tasks) {
      const absPath = resolve(projectRoot, task.file);
      let fileTokens = 0;

      try {
        const content = readFileSync(absPath, 'utf-8');
        fileTokens = enc.encode(content).length;
      } catch {
        // File may have been deleted since scan; estimate from symbols
        fileTokens = task.symbols.reduce(
          (sum, s) => sum + (s.line_end - s.line_start + 1) * 8,
          0,
        );
      }

      const symbolCount = task.symbols.length;
      totalSymbols += symbolCount;

      // Input: system prompt + file content + per-file overhead
      totalInputTokens += SYSTEM_PROMPT_TOKENS + fileTokens + PER_FILE_OVERHEAD_TOKENS;

      // Output: base per file + per-symbol review
      totalOutputTokens += OUTPUT_BASE_PER_FILE + symbolCount * OUTPUT_TOKENS_PER_SYMBOL;
    }
  } finally {
    enc.free();
  }

  return { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, symbols: totalSymbols };
}

/**
 * Estimate token usage and time for reviewing all scanned files.
 * Reads actual file content to get accurate input token counts.
 */
export function estimateProject(projectRoot: string): EstimateResult {
  const tasks = loadTasks(projectRoot);

  if (tasks.length === 0) {
    return { files: 0, symbols: 0, inputTokens: 0, outputTokens: 0, estimatedMinutes: 0, estimatedCalls: 0 };
  }

  const { inputTokens, outputTokens, symbols } = estimateTasksTokens(projectRoot, tasks);

  const estimatedMinutes = Math.ceil(estimateSequentialSeconds(tasks) / 60);
  const estimatedCalls = tasks.length * AXIS_COUNT;

  return {
    files: tasks.length,
    symbols,
    inputTokens,
    outputTokens,
    estimatedMinutes,
    estimatedCalls,
  };
}

/**
 * Forecast the LLM and embedding workload for a run, including a $ cost
 * projection per axis model.
 *
 * Token counts are multiplied by the number of active axes — each axis is a
 * full pass over the evaluate-tier files. Cost per axis is computed via
 * {@link calculateCost} using the run's pricing cache (must have been
 * hydrated with `ensurePricing` first).
 *
 * Embedding cost is non-zero only when an external embedding model is
 * resolved through the pricing cache (Voyage, OpenRouter, Mistral, …).
 * Local embeddings (jina, MiniLM) return 0 because they have no API
 * pricing entry — that's the right number, the user pays nothing.
 *
 * Known limitations (documented for honesty in the forecast):
 * - NLP-summary calls (Haiku summarising functions for the RAG index)
 *   are not yet modeled; their tokens land in `embed.tokens` only when
 *   the embed model is external. The user accepted this gap as a
 *   follow-up — see step 5 of the cost-line refactor discussion.
 * - Retries, RAG-doc-gen calls, and refinement passes are also outside
 *   this projection; the SDK's `total_cost_usd` covers those at run
 *   time but estimate is a forecast, not a replay.
 */
export interface RunForecast {
  /** Files that will actually be evaluated (post-triage). */
  files: number;
  /** Files scanned (pre-triage). */
  totalFiles: number;
  /** Files filtered out by triage. */
  skippedFiles: number;
  llm: {
    /** New (uncached) input tokens across all axis passes. */
    inputTokens: number;
    outputTokens: number;
    /** Sum across active axis models. */
    costUsd: number;
    /** Cost grouped by short model name (e.g. `sonnet-4-6`). */
    costByModel: Record<string, number>;
  };
  embed: {
    tokens: number;
    /** Total cost for code + nlp embeddings; 0 when models are local. */
    costUsd: number;
    /** Number of code embedding calls (functions). */
    codeUnits: number;
    /** Number of NLP embedding calls (function summaries + doc chunks). */
    nlpUnits: number;
  };
  /** Sum of llm.input + llm.output + embed.tokens. */
  totalTokens: number;
  /** Sum of llm.costUsd + embed.costUsd. */
  totalCostUsd: number;
  /** Calibrated wall-clock estimate in minutes, accounting for concurrency. */
  calibratedMin: number;
  /** True when at least one axis has empirical samples; false ⇒ default medians. */
  hasCalibration: boolean;
}

export interface ForecastInputs {
  projectRoot: string;
  /** Tasks that survived triage and will be evaluated. */
  evalTasks: Task[];
  /** Total files scanned (pre-triage). */
  totalFiles: number;
  /** Active axis evaluators with their resolved model id. */
  axes: ReadonlyArray<{ id: string; model: string }>;
  /**
   * Embed forecast bundle when RAG is enabled.
   *
   * `codeModel` / `nlpModel` are optional: when set, the corresponding
   * embedding cost is computed via {@link calculateCost} against the
   * pricing cache. Local models (ONNX / GGUF) have no entry in the cache,
   * so `calculateCost` returns 0 — exactly the right answer for free local
   * embeddings. External SDK models (Voyage, OpenRouter, Mistral, …) get
   * costed at their per-token rate.
   *
   * When the models are omitted, the forecast surfaces token counts but
   * leaves embed cost at 0 — matches the original Pass 1 behavior.
   */
  embed?: {
    codeTokens: number;
    codeUnits: number;
    nlpTokens: number;
    nlpUnits: number;
    codeModel?: string;
    nlpModel?: string;
  };
  /**
   * NLP-summarizer model id (typically Haiku via {@link resolveCodeSummaryModel}).
   * When set together with a non-empty `embed`, the forecast adds the
   * summarizer's token cost to the LLM totals — one call per file with
   * functions, input ≈ embed.codeTokens, output ≈ codeUnits ×
   * {@link NLP_TOKENS_PER_FUNCTION}. Tokens land in `llm.inputTokens` /
   * `llm.outputTokens` per the contract: NLP summary stays in the LLM count.
   */
  summaryModel?: string;
  calibration: CalibrationData;
  concurrency: number;
  ragEnabled: boolean;
  deliberation: boolean;
}

export function forecastRun(args: ForecastInputs): RunForecast {
  const { projectRoot, evalTasks, totalFiles, axes, embed, summaryModel, calibration, concurrency, ragEnabled, deliberation } = args;

  // Per-pass token cost (one axis × all eval files) — same as today's
  // `estimateTasksTokens` on the eval set.
  const { inputTokens: perPassInput, outputTokens: perPassOutput } = estimateTasksTokens(projectRoot, evalTasks);

  // Each active axis runs a full pass; total tokens scale linearly.
  let llmInputTokens = perPassInput * axes.length;
  let llmOutputTokens = perPassOutput * axes.length;

  // Cost per axis (each axis's model can differ). Distribute one pass per axis,
  // accumulate by short model name for the breakdown line.
  const costByModel: Record<string, number> = {};
  let llmCost = 0;
  for (const axis of axes) {
    const c = calculateCost(axis.model, perPassInput, perPassOutput, projectRoot);
    const key = shortModelKey(axis.model);
    costByModel[key] = (costByModel[key] ?? 0) + c;
    llmCost += c;
  }

  // Embed tokens are surfaced. Cost is computed when codeModel / nlpModel
  // are provided — local models return 0 from calculateCost (no pricing
  // entry → free), external SDK models return their per-token rate.
  let embedTokens = 0;
  let embedCost = 0;
  let codeUnits = 0;
  let nlpUnits = 0;
  if (embed) {
    embedTokens = embed.codeTokens + embed.nlpTokens;
    codeUnits = embed.codeUnits;
    nlpUnits = embed.nlpUnits;
    if (embed.codeModel && embed.codeTokens > 0) {
      embedCost += calculateCost(embed.codeModel, embed.codeTokens, 0, projectRoot);
    }
    if (embed.nlpModel && embed.nlpTokens > 0) {
      embedCost += calculateCost(embed.nlpModel, embed.nlpTokens, 0, projectRoot);
    }
  }

  // NLP summarizer cost: one LLM call per file with functions. We approximate
  // input as the function-body token sum and output as units × the per-function
  // budget the embed-estimator already uses (NLP_TOKENS_PER_FUNCTION) — the
  // observed summary text size. Tokens are merged into the LLM totals because
  // the user opted to keep the summary work in the LLM in/out count.
  if (summaryModel && embed && embed.codeUnits > 0) {
    const summaryInput = embed.codeTokens;
    const summaryOutput = embed.codeUnits * NLP_TOKENS_PER_FUNCTION;
    llmInputTokens += summaryInput;
    llmOutputTokens += summaryOutput;
    const summaryCost = calculateCost(summaryModel, summaryInput, summaryOutput, projectRoot);
    const summaryKey = shortModelKey(summaryModel);
    costByModel[summaryKey] = (costByModel[summaryKey] ?? 0) + summaryCost;
    llmCost += summaryCost;
  }

  const calibratedMin = estimateCalibratedMinutes(
    calibration,
    evalTasks.length,
    axes.map((a) => a.id),
    concurrency,
    0.75,
    { rag: ragEnabled, deliberation },
  );
  const hasCalibration = Object.values(calibration.axes).some((a) => a.samples > 0);

  return {
    files: evalTasks.length,
    totalFiles,
    skippedFiles: totalFiles - evalTasks.length,
    llm: {
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      costUsd: llmCost,
      costByModel,
    },
    embed: {
      tokens: embedTokens,
      costUsd: embedCost,
      codeUnits,
      nlpUnits,
    },
    totalTokens: llmInputTokens + llmOutputTokens + embedTokens,
    totalCostUsd: llmCost + embedCost,
    calibratedMin,
    hasCalibration,
  };
}

/** Group axis costs by a compact model key (e.g. "claude-sonnet-4-6" → "sonnet-4-6"). */
function shortModelKey(modelId: string): string {
  return modelId.replace(/^[^/]+\//, '').replace(/^claude-/, '');
}

/**
 * Format a token count for display (e.g., 1200000 → "~1.2M", 340000 → "~340K").
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `~${millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = Math.round(count / 1_000);
    return `~${thousands}K`;
  }
  return `~${count}`;
}
