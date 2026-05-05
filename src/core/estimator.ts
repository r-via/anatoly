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
 * One discrete cost contribution in the forecast — typically one logical
 * pipeline phase that hits the LLM (or embedding API). Examples:
 *
 *   { id: 'axis:correction',  model: 'anthropic/claude-sonnet-4-6', costUsd: 5.20 }
 *   { id: 'summary',          model: 'anthropic/claude-haiku-4-5',  costUsd: 0.21 }
 *   { id: 'embed:code',       model: 'voyage/voyage-code-3',        costUsd: 0.05 }
 *   { id: 'embed:nlp',        model: 'local',                       costUsd: 0    }
 *   { id: 'doc:bootstrap',    model: 'anthropic/claude-opus-4-6',   costUsd: 1.20 }
 *
 * Steps are the source of truth for the per-step display in the Forecast
 * block and for the `--json` payload. Aggregates on {@link RunForecast}
 * (llm.*, embed.*, totalCostUsd) are derived from this array.
 */
export interface ForecastStep {
  /** Category-prefixed id (`axis:<name>`, `summary`, `embed:code|nlp`, `doc:bootstrap|update`). */
  id: string;
  /** Resolved model id; `'local'` for local-runtime embeddings (no API price). */
  model: string;
  /** Net new (uncached) input tokens billed at the input rate. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from the prompt cache (Anthropic — billed at cacheReadInput rate). */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache on the first call (billed at cacheCreationInput rate). */
  cacheCreationTokens?: number;
  costUsd: number;
  /**
   * True for steps whose token counts come from heuristics (doc:bootstrap,
   * doc:update). Display uses this to prefix the cost with `~` so the user
   * knows the number is an order-of-magnitude estimate, not a precise math.
   */
  approximate?: boolean;
}

/**
 * Forecast the LLM and embedding workload for a run, with a $ cost
 * projection per pipeline step (axis, NLP summary, embeddings, doc-gen).
 *
 * Axis tokens are multiplied by the number of active axes — each axis is
 * a full pass over the evaluate-tier files. Each axis pass benefits from
 * Anthropic's prompt caching: the per-call SYSTEM prompt is written to
 * cache on the first file and read from cache on every subsequent file
 * (cache_read at ~10% of input rate). The file content itself stays
 * fresh because it changes per call.
 *
 * Doc-generation steps (bootstrap on first run, update on subsequent
 * runs) are estimated from a per-page heuristic that accounts for the
 * multi-turn nature of the agentic Read-tool conversation.
 *
 * Embedding cost is non-zero only when an external embedding model is
 * resolved through the pricing cache (Voyage, OpenRouter, Mistral, …).
 * Local embeddings (jina, MiniLM, GGUF) have no API pricing entry, so
 * `calculateCost` returns 0 — that's the right number, they're free.
 *
 * Known limitations:
 * - Retries / refinement / deliberation are not modeled; the SDK's
 *   `total_cost_usd` covers those at run time but estimate is a
 *   forecast, not a replay.
 */
export interface RunForecast {
  /** Files that will actually be evaluated (post-triage). */
  files: number;
  /** Files scanned (pre-triage). */
  totalFiles: number;
  /** Files filtered out by triage. */
  skippedFiles: number;
  /** Per-step breakdown — primary user-facing structure. */
  steps: ForecastStep[];
  llm: {
    /** New (uncached) input tokens across all LLM steps (axes + summary + doc). */
    inputTokens: number;
    outputTokens: number;
    /** Sum across all LLM steps. */
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
  /**
   * Doc-generation context. When provided, the forecast adds a `doc:*` step
   * sized via the per-page heuristic that models the multi-turn agentic
   * Read-tool conversation: per-page accumulated context becomes cache
   * reads after turn 1, only tool_results and per-turn deltas pay fresh
   * input rates. Constants (DOC_BOOTSTRAP_PER_PAGE / DOC_UPDATE_PER_PAGE)
   * are exported for tuning from empirical run data later.
   */
  docContext?: {
    mode: 'bootstrap' | 'update';
    pageCount: number;
    scaffoldingModel: string;
  };
  calibration: CalibrationData;
  concurrency: number;
  ragEnabled: boolean;
  deliberation: boolean;
}

/**
 * Per-page token budget for doc-generation steps. The agentic Read-tool
 * conversation runs ~3-7 turns per page; each turn appends to the
 * conversation, but Anthropic's automatic prompt caching covers most of
 * the accumulated context. So per-page tokens split into:
 *
 *   - `fresh`         — tool_result bodies + per-turn deltas (billed input)
 *   - `cacheRead`     — accumulated context re-read on every turn after the first
 *   - `cacheCreation` — initial system+user prompt cached on turn 1
 *   - `output`        — sum of per-turn outputs (mostly small tool-call
 *                       wrappers + the final doc text)
 *
 * Exported so tooling can recalibrate from observed runs (analogous to
 * `recalibrateFromRuns` for axis durations).
 */
export const DOC_BOOTSTRAP_PER_PAGE = {
  fresh: 3000,
  cacheRead: 7000,
  cacheCreation: 600,
  output: 3500,
} as const;

/** Update mode is lighter — the agent reads less context, edits more locally. */
export const DOC_UPDATE_PER_PAGE = {
  fresh: 2000,
  cacheRead: 4000,
  cacheCreation: 600,
  output: 2000,
} as const;

export function forecastRun(args: ForecastInputs): RunForecast {
  const { projectRoot, evalTasks, totalFiles, axes, embed, summaryModel, docContext, calibration, concurrency, ragEnabled, deliberation } = args;
  const steps: ForecastStep[] = [];

  // Per-pass token cost (one axis × all eval files) — `estimateTasksTokens`
  // returns aggregate for the whole evaluate set.
  const E = evalTasks.length;
  const { inputTokens: perPassInput, outputTokens: perPassOutput } = estimateTasksTokens(projectRoot, evalTasks);

  // Decompose per-pass input into the cache-friendly portion (SYSTEM, identical
  // across files for a given axis ⇒ cached after the first call) and the
  // fresh portion (file content + per-call overhead, different every call).
  // For E files, cache_creation = SYSTEM (one write), cache_read = SYSTEM × (E−1).
  // Models without cache rates (non-Anthropic) fall back to input rate via
  // calculateCost's pricing.cacheReadInput ?? pricing.input — that yields the
  // naive cost, exactly what we want for providers without prompt caching.
  const sumFileTokens = Math.max(0, perPassInput - E * SYSTEM_PROMPT_TOKENS - E * PER_FILE_OVERHEAD_TOKENS);
  const freshInputPerAxis = sumFileTokens + E * PER_FILE_OVERHEAD_TOKENS;
  const cacheReadSystemPerAxis = SYSTEM_PROMPT_TOKENS * Math.max(0, E - 1);
  const cacheCreationSystemPerAxis = E > 0 ? SYSTEM_PROMPT_TOKENS : 0;

  for (const axis of axes) {
    const cost = calculateCost(axis.model, freshInputPerAxis, perPassOutput, projectRoot, {
      read: cacheReadSystemPerAxis,
      creation: cacheCreationSystemPerAxis,
    });
    steps.push({
      id: `axis:${axis.id}`,
      model: axis.model,
      inputTokens: freshInputPerAxis,
      outputTokens: perPassOutput,
      cacheReadTokens: cacheReadSystemPerAxis,
      cacheCreationTokens: cacheCreationSystemPerAxis,
      costUsd: cost,
    });
  }

  // NLP summarizer: one LLM call per file with functions, no cache modeling
  // (system prompt does benefit from caching across files in reality, but the
  // approximation is good enough — the call dominates on file content not
  // system prompt). Tokens merged into LLM totals per the contract.
  if (summaryModel && embed && embed.codeUnits > 0) {
    const summaryInput = embed.codeTokens;
    const summaryOutput = embed.codeUnits * NLP_TOKENS_PER_FUNCTION;
    steps.push({
      id: 'summary',
      model: summaryModel,
      inputTokens: summaryInput,
      outputTokens: summaryOutput,
      costUsd: calculateCost(summaryModel, summaryInput, summaryOutput, projectRoot),
    });
  }

  // Embed steps — one per axis (code, nlp). Surfaced even when local so the
  // user sees the work; cost is 0 when models have no pricing entry.
  if (embed && embed.codeTokens > 0) {
    const cost = embed.codeModel
      ? calculateCost(embed.codeModel, embed.codeTokens, 0, projectRoot)
      : 0;
    steps.push({
      id: 'embed:code',
      model: embed.codeModel ?? 'local',
      inputTokens: embed.codeTokens,
      outputTokens: 0,
      costUsd: cost,
    });
  }
  if (embed && embed.nlpTokens > 0) {
    const cost = embed.nlpModel
      ? calculateCost(embed.nlpModel, embed.nlpTokens, 0, projectRoot)
      : 0;
    steps.push({
      id: 'embed:nlp',
      model: embed.nlpModel ?? 'local',
      inputTokens: embed.nlpTokens,
      outputTokens: 0,
      costUsd: cost,
    });
  }

  // Doc-generation: heuristic per-page cost that models the multi-turn
  // agentic conversation with prompt caching. See DOC_*_PER_PAGE jsdoc for
  // the breakdown. Marked `approximate: true` so display can prefix `~`.
  if (docContext && docContext.pageCount > 0) {
    const c = docContext.mode === 'bootstrap' ? DOC_BOOTSTRAP_PER_PAGE : DOC_UPDATE_PER_PAGE;
    const docFresh = docContext.pageCount * c.fresh;
    const docCacheRead = docContext.pageCount * c.cacheRead;
    const docCacheCreation = docContext.pageCount * c.cacheCreation;
    const docOutput = docContext.pageCount * c.output;
    steps.push({
      id: `doc:${docContext.mode}`,
      model: docContext.scaffoldingModel,
      inputTokens: docFresh,
      outputTokens: docOutput,
      cacheReadTokens: docCacheRead,
      cacheCreationTokens: docCacheCreation,
      costUsd: calculateCost(docContext.scaffoldingModel, docFresh, docOutput, projectRoot, {
        read: docCacheRead,
        creation: docCacheCreation,
      }),
      approximate: true,
    });
  }

  // Aggregate from steps — single source of truth: any new step type lands
  // in totals automatically.
  const isLlm = (s: ForecastStep) => !s.id.startsWith('embed:');
  const llmSteps = steps.filter(isLlm);
  const embedSteps = steps.filter((s) => s.id.startsWith('embed:'));

  const llmInputTokens = llmSteps.reduce((sum, s) => sum + s.inputTokens, 0);
  const llmOutputTokens = llmSteps.reduce((sum, s) => sum + s.outputTokens, 0);
  const llmCost = llmSteps.reduce((sum, s) => sum + s.costUsd, 0);
  const costByModel: Record<string, number> = {};
  for (const s of llmSteps) {
    const key = shortModelKey(s.model);
    costByModel[key] = (costByModel[key] ?? 0) + s.costUsd;
  }

  const embedTokens = embedSteps.reduce((sum, s) => sum + s.inputTokens, 0);
  const embedCost = embedSteps.reduce((sum, s) => sum + s.costUsd, 0);
  const codeUnits = embed?.codeUnits ?? 0;
  const nlpUnits = embed?.nlpUnits ?? 0;

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
    steps,
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
