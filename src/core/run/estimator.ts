// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { anatolyPath } from '../../utils/anatoly-paths.js';
import { get_encoding } from 'tiktoken';
import { TaskSchema, type Task } from '../../schemas/task.js';
import { ALL_AXIS_IDS } from '../evaluation/axes/index.js';
import { calculateCost } from '../../utils/cost-calculator.js';
import { estimateCalibratedMinutes, type CalibrationData } from '../evaluation/calibration.js';
import { NLP_TOKENS_PER_FUNCTION } from '../../rag/embed-estimator.js';

const SYSTEM_PROMPT_TOKENS = 600;
const PER_FILE_OVERHEAD_TOKENS = 50;
/**
 * Shape of the per-file output volume: a fixed part plus a part per symbol
 * (R1/R2 runs, 2026-06). Only the shape matters: the level of each axis is
 * set by `outputMultiplier` in {@link AXIS_CALL_PROFILES}.
 */
const OUTPUT_TOKENS_PER_SYMBOL = 400;
const OUTPUT_BASE_PER_FILE = 1500;

/**
 * Model generation an LLM call is calibrated for. Claude 5.x answers an axis
 * with 2.5 to 4 times fewer output tokens than Claude 4.6 (same prompts,
 * effort high) and writes more of its prompt to the cache, so each generation
 * has its own measured profile. Anything that is not a Claude 4.x model,
 * including non-Claude models, uses the current generation's profile.
 */
export type ModelGeneration = 'claude-5' | 'claude-4';

export function modelGeneration(modelId: string): ModelGeneration {
  return /claude-(?:opus|sonnet|haiku)-4(?:-|$)/.test(modelId) ? 'claude-4' : 'claude-5';
}

/**
 * Prompt-cache TTL a provider writes with. The `anthropic` provider always
 * runs on the Claude Agent SDK transport (`transportForProvider`), which
 * writes its cache for 1 hour: every first-attempt call of the 2026-10-25
 * slot-engine runs is billed at the 1-hour rate, to the cent (runs under
 * OAuth; the same TTL is assumed for API-key auth). Other providers go through
 * the Vercel AI SDK transport, which leaves the default 5-minute TTL.
 */
export function cacheWriteTtl(modelId: string): '5m' | '1h' {
  return modelId.startsWith('anthropic/') ? '1h' : '5m';
}

/**
 * Measured profile of one axis LLM call on the Claude Agent SDK transport.
 *
 * - `callRate`: share of the evaluated files for which the axis actually
 *   calls the LLM. Utility and duplication settle most files without one
 *   (usage graph, no similar candidate), the other axes call for almost
 *   every file. Same rate on both generations.
 * - `outputMultiplier`: output per call, relative to the
 *   `OUTPUT_BASE_PER_FILE + OUTPUT_TOKENS_PER_SYMBOL × symbols` baseline
 *   (2940 tokens per file on the calibration fixture: 29 400 for its 10
 *   evaluated files).
 * - `cacheReadPerCall`: tokens read from the prompt cache on each call. About
 *   13K is the Claude Code system prompt and tool definitions, the rest is
 *   the axis system prompt once cached. Fresh input is ~2 tokens per call.
 * - `contextPerCall`: tokens written to the cache on each call besides the
 *   file content itself (axis prompt on first write, RAG neighbours, project
 *   context). The file content (cl100k count) is added on top.
 */
export interface AxisCallProfile {
  readonly callRate: number;
  readonly outputMultiplier: number;
  readonly cacheReadPerCall: number;
  readonly contextPerCall: number;
}

/** Fresh (uncached) input per call on the Claude Agent SDK transport. */
export const FRESH_INPUT_PER_CALL = 2;

/**
 * Axis call profiles per generation. Measured on the slot-engine bench
 * fixture on the VM on 2026-10-25 (`costs/ledger.ndjson`, first attempts
 * only): 8 runs on sonnet-5-5 / opus-5-5 / haiku-5-5, 4 runs on sonnet-4-6 /
 * opus-4-6 / haiku-4-5, same ANA-7 prompts, effort high, RAG on, 11 evaluated
 * files of ~320 cl100k tokens each.
 * Measured per call (output / cache read / cache write), 5.5 then 4.6:
 *   best_practices   2034 / 16390 / 5549    5184 / 16269 / 3874
 *   correction        796 / 18649 / 6000    3121 / 19191 / 3019
 *   duplication       618 / 12705 / 5715    1179 / 16445 / 1230
 *   overengineering   331 / 14117 / 4644    1005 / 16672 / 1191
 *   utility           645 / 14472 / 4096    1574 / 16440 / 1367
 * `contextPerCall` = measured cache write minus the ~320 tokens of file
 * content. With this profile the forecast lands on the measured mean run
 * cost of the fixture (ANA-19).
 *
 * `tests` and `documentation` are disabled on that fixture: their output is
 * extrapolated from the 2026-06 R3 multipliers (0.14 and 0.31, scaled by the
 * 0.57 ratio between the R3 and 2026-10 4.6 multipliers of the measured axes,
 * then by the 0.38 ratio between the 5.5 and 4.6 outputs), their cache
 * volumes are the mean of the measured axes, their call rate is 1.
 *
 * Known limits: the context written per call was measured with RAG on and
 * small files; RAG off is not subtracted (slight over-estimate). Non-Claude
 * models use the claude-5 profile although they do not carry the Claude Code
 * system prompt (over-estimates their cache reads, a small cost).
 */
export const AXIS_CALL_PROFILES: Record<ModelGeneration, Record<string, AxisCallProfile>> = {
  'claude-5': {
    best_practices: { callRate: 0.91, outputMultiplier: 0.692, cacheReadPerCall: 16390, contextPerCall: 5229 },
    correction: { callRate: 1, outputMultiplier: 0.271, cacheReadPerCall: 18649, contextPerCall: 5680 },
    duplication: { callRate: 0.36, outputMultiplier: 0.21, cacheReadPerCall: 12705, contextPerCall: 5395 },
    overengineering: { callRate: 0.91, outputMultiplier: 0.113, cacheReadPerCall: 14117, contextPerCall: 4324 },
    utility: { callRate: 0.18, outputMultiplier: 0.219, cacheReadPerCall: 14472, contextPerCall: 3776 },
    documentation: { callRate: 1, outputMultiplier: 0.068, cacheReadPerCall: 15267, contextPerCall: 4881 },
    tests: { callRate: 1, outputMultiplier: 0.031, cacheReadPerCall: 15267, contextPerCall: 4881 },
  },
  'claude-4': {
    best_practices: { callRate: 0.91, outputMultiplier: 1.763, cacheReadPerCall: 16269, contextPerCall: 3554 },
    correction: { callRate: 1, outputMultiplier: 1.062, cacheReadPerCall: 19191, contextPerCall: 2699 },
    duplication: { callRate: 0.36, outputMultiplier: 0.401, cacheReadPerCall: 16445, contextPerCall: 910 },
    overengineering: { callRate: 0.91, outputMultiplier: 0.342, cacheReadPerCall: 16672, contextPerCall: 871 },
    utility: { callRate: 0.18, outputMultiplier: 0.535, cacheReadPerCall: 16440, contextPerCall: 1047 },
    documentation: { callRate: 1, outputMultiplier: 0.178, cacheReadPerCall: 17003, contextPerCall: 1816 },
    tests: { callRate: 1, outputMultiplier: 0.08, cacheReadPerCall: 17003, contextPerCall: 1816 },
  },
};

/** Profile for an axis id absent from the table (e.g. a new axis): an average call. */
const DEFAULT_AXIS_CALL_PROFILE: Record<ModelGeneration, AxisCallProfile> = {
  'claude-5': { callRate: 1, outputMultiplier: 0.3, cacheReadPerCall: 15267, contextPerCall: 4881 },
  'claude-4': { callRate: 1, outputMultiplier: 0.8, cacheReadPerCall: 17003, contextPerCall: 1816 },
};

export function axisCallProfile(axisId: string, modelId: string): AxisCallProfile {
  const generation = modelGeneration(modelId);
  return AXIS_CALL_PROFILES[generation][axisId] ?? DEFAULT_AXIS_CALL_PROFILE[generation];
}

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
 * Load all .task.json files from the tasks directory and drop entries whose
 * source file no longer exists in the current project tree.
 *
 * The filesystem check guards against stale tasks from a previous scan in a
 * different repo (cross-project contamination) or from files that have since
 * been deleted. Without it, `estimate` and downstream consumers would inflate
 * scope based on the cache rather than the current source of truth — the
 * scanner output. The current source tree wins.
 */
export function loadTasks(projectRoot: string): Task[] {
  const tasksDir = anatolyPath(projectRoot, 'cache', 'tasks');
  if (!existsSync(tasksDir)) return [];

  const entries = readdirSync(tasksDir).filter((f) => f.endsWith('.task.json'));
  const tasks: Task[] = [];

  for (const entry of entries) {
    try {
      const raw = readFileSync(join(tasksDir, entry), 'utf-8');
      const task = TaskSchema.parse(JSON.parse(raw));
      if (!existsSync(resolve(projectRoot, task.file))) continue;
      tasks.push(task);
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

  // estimateTasksTokens models a single pass over all files (one axis). A real
  // run evaluates every file across all axes, so scale the token totals by
  // AXIS_COUNT to match estimatedCalls — otherwise inputTokens/outputTokens
  // report 1/AXIS_COUNT of the run while estimatedCalls reports the full count.
  const single = estimateTasksTokens(projectRoot, tasks);
  const inputTokens = single.inputTokens * AXIS_COUNT;
  const outputTokens = single.outputTokens * AXIS_COUNT;
  const symbols = single.symbols;

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
 * Category bucket for a {@link ForecastStep}. Used both for grouping in the
 * rendered breakdown table and for ordered sorting (axis → deliberation →
 * summary → embed → internal-doc).
 */
export type ForecastStepCategory = 'axis' | 'deliberation' | 'summary' | 'embed' | 'internal-doc';

/**
 * One discrete cost contribution in the forecast — typically one logical
 * pipeline phase that hits the LLM (or embedding API). Examples:
 *
 *   { category: 'axis',    name: 'correction',  model: 'anthropic/claude-sonnet-4-6', costUsd: 5.20 }
 *   { category: 'summary', name: '',            model: 'anthropic/claude-haiku-4-5',  costUsd: 0.21 }
 *   { category: 'embed',   name: 'code',        model: 'voyage/voyage-code-3',        costUsd: 0.05 }
 *   { category: 'embed',   name: 'text',        model: 'local',                       costUsd: 0    }
 *   { category: 'doc',     name: 'bootstrap',   model: 'anthropic/claude-opus-4-6',   costUsd: 1.20 }
 *
 * `category` and `name` are kept as separate fields so consumers (display,
 * `--json` API) can render them in distinct columns / properties without
 * having to parse a prefixed id string.
 *
 * Steps are the source of truth for the per-step display in the Forecast
 * block and for the `--json` payload. Aggregates on {@link RunForecast}
 * (llm.*, embed.*, totalCostUsd) are derived from this array.
 */
/**
 * How the user is billed for this step's cost:
 *   - `subscription` — covered by an OAuth subscription (Claude Code), the
 *     user does not pay the displayed cost. The displayed value is the
 *     pay-per-token equivalent ("consumption magnitude").
 *   - `api`          — pay-per-token via API key. The displayed cost is real.
 *   - `local`        — local runtime (ONNX / GGUF), no API call, free.
 */
export type ForecastStepBillingMode = 'subscription' | 'api' | 'local';

export interface ForecastStep {
  category: ForecastStepCategory;
  /** Sub-identifier within the category. Empty string when the category has a single canonical entry (e.g. `summary`). */
  name: string;
  /** Resolved model id; `'local'` for local-runtime embeddings (no API price). */
  model: string;
  /** Per-step billing mode — determines whether costUsd is real or pay-per-token equivalent. */
  billingMode: ForecastStepBillingMode;
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
 * Canonical category order for sorting steps in the breakdown view.
 * Roughly chronological in execution: axis review → deliberation refinement
 * → RAG summary → RAG embeddings → internal-doc generation.
 * Within each category, callers sort by costUsd desc.
 */
export const FORECAST_STEP_CATEGORY_ORDER: ReadonlyArray<ForecastStepCategory> = [
  'axis', 'deliberation', 'summary', 'embed', 'internal-doc',
];

/**
 * Deliberation runs as a single deliberation-model call per *shard* of
 * escalated findings (see `core/refinement/tier3.ts:buildShards` — shards
 * are grouped by directory module, capped at 20 files each). Crucially,
 * most findings get resolved by tier-1/2 (cache + coherence) before tier-3
 * ever sees them, so the deliberation cost is roughly **invariant of axes
 * × file count**: observed at $0.30 (R1, 1 file), $0.41 (R2, 2 files), and
 * $0.38 (R3, 11 files) — essentially flat per shard.
 *
 * The forecast therefore models the deliberation step as `shardCount ×
 * fixed-tokens-per-shard` instead of the old `coverage × axes × E` model
 * which scaled multiplicatively with axes and files. Token shape is
 * dominated by output (structured per-finding decisions on opus).
 */
/**
 * Per-shard token shape of the tier-3 deliberation call, per generation.
 * Measured on the same 2026-10-25 slot-engine runs as
 * {@link AXIS_CALL_PROFILES} (one shard per run, first attempts only):
 * opus-5-5 ≈ $0.345 per shard, opus-4-6 ≈ $0.306 per shard at the 1-hour
 * cache-write rate. Like the axis calls, the whole prompt goes through the
 * cache: fresh input is a handful of tokens. Retries are not modeled (2 of the
 * 8 runs on 5.5 retried the shard once, +$0.14 each).
 */
export interface DeliberationShardProfile {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

export const DELIBERATION_SHARD_PROFILES: Record<ModelGeneration, DeliberationShardProfile> = {
  'claude-5': { input: 9, output: 6468, cacheRead: 102495, cacheCreation: 24225 },
  'claude-4': { input: 4, output: 5601, cacheRead: 46241, cacheCreation: 14311 },
};

/**
 * Forecast the LLM and embedding workload for a run, with a $ cost
 * projection per pipeline step (axis, NLP summary, embeddings, doc-gen).
 *
 * Each active axis is one step: the share of the evaluate-tier files that
 * reach the LLM for that axis, priced with the measured per-call profile of
 * the axis model's generation ({@link AXIS_CALL_PROFILES}). On the Claude
 * Agent SDK transport the whole prompt goes through the prompt cache: a
 * fixed cache read per call (the Claude Code system prompt) and a cache
 * write per call (file and context), written with the 1-hour TTL.
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
 * - Retries are not modeled; the SDK's `total_cost_usd` covers them at run
 *   time but the estimate is a forecast, not a replay.
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
    /**
     * Cached input tokens *read* across all LLM steps. Billed at the
     * provider's cacheReadInput rate (~10% of input on Anthropic). Excluded
     * from {@link inputTokens} to keep "fresh" vs "cached" cost decomposable;
     * surfaced here so the displayed token total isn't misleadingly small
     * (internal-doc bootstrap alone can read ~2M cached tokens per run).
     */
    cacheReadTokens: number;
    /** Cached input tokens *written* on first call of each cacheable prompt. */
    cacheCreationTokens: number;
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
   * Deliberation model id (typically Opus). When set together with
   * `deliberation: true` and a non-empty axis list, the forecast adds a
   * `deliberation` step approximated as {@link DELIBERATION_COVERAGE} of
   * the per-axis token volume costed at the deliberation model rate.
   * Marked approximate (the real coverage varies by findings ambiguity).
   */
  deliberationModel?: string;
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
  /**
   * Resolves the billing mode for a model id. Lets the estimator stay
   * decoupled from the config schema while still tagging each step with
   * its billing mode (subscription / api / local). The caller passes a
   * function that consults `config.providers[provider].mode` and the
   * known-local embedding labels.
   */
  resolveBillingMode: (modelId: string) => ForecastStepBillingMode;
  /**
   * When true, the forecast includes a `conflict-detection` step under
   * `internal-doc` category (1 Sonnet call). Set to true when docMode is
   * `full`, false otherwise.
   */
  docConflictDetection?: boolean;
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
  fresh: 100,
  cacheRead: 100000,
  cacheCreation: 12000,
  output: 12500,
} as const;

/** Update mode is lighter — the agent reads less context, edits more locally. */
export const DOC_UPDATE_PER_PAGE = {
  fresh: 2000,
  cacheRead: 4000,
  cacheCreation: 600,
  output: 2000,
} as const;

/**
 * Coherence review pass — single Sonnet agent that reads ALL bootstrapped
 * pages and rewrites them via the Write tool to fix cross-page issues.
 * Runs once per bootstrap (not on update mode). Cost scales with the total
 * scaffolded page count: more pages → more content injected, more edits emitted.
 *
 * Constants are calibrated empirically from R1 (18 pages, $2.77 on
 * sonnet-4-6). Per-page shape is dominated by output tokens (Write-tool
 * deltas as the agent rewrites each page), with cached input growing
 * across the agent's multi-turn editing loop.
 */
export const DOC_COHERENCE_PER_PAGE = {
  fresh: 3000,
  cacheRead: 12000,
  cacheCreation: 2000,
  output: 12500,
} as const;

/**
 * Token budget for the doc-conflict-detector agent — a single LLM call per run
 * in `full` mode that reads internal doc fragments + code anchors and identifies
 * doc-code conflicts. Modeled as 1 Sonnet call with moderate context.
 *
 * Calibrated conservatively: the detector reads ~4K tokens of doc fragments and
 * ~4K of code context, emits a structured YAML response of ~2K tokens.
 */
export const DOC_CONFLICT_DETECTOR_TOKENS = {
  input: 8000,
  output: 2000,
} as const;

export function forecastRun(args: ForecastInputs): RunForecast {
  const { projectRoot, evalTasks, totalFiles, axes, embed, summaryModel, deliberationModel, docContext, docConflictDetection, resolveBillingMode, calibration, concurrency, ragEnabled, deliberation } = args;
  const steps: ForecastStep[] = [];

  // Per-pass token cost (one axis × all eval files) — `estimateTasksTokens`
  // returns aggregate for the whole evaluate set.
  const E = evalTasks.length;
  const { inputTokens: perPassInput, outputTokens: perPassOutput } = estimateTasksTokens(projectRoot, evalTasks);

  // Each axis call sends its whole prompt through the SDK prompt cache (see
  // AXIS_CALL_PROFILES): a fixed read per call (Claude Code system prompt +
  // cached axis system prompt) and a write per call (per-file context + file
  // content). Only `callRate × E` files reach the LLM; the rest are settled
  // deterministically. Expected values, so call counts may be fractional:
  // tokens are rounded per step. Models without cache rates (non-Anthropic)
  // fall back to the input rate in calculateCost, which yields the naive cost.
  const sumFileTokens = Math.max(0, perPassInput - E * SYSTEM_PROMPT_TOKENS - E * PER_FILE_OVERHEAD_TOKENS);

  for (const axis of axes) {
    const profile = axisCallProfile(axis.id, axis.model);
    const calls = E * profile.callRate;
    const axisInput = Math.round(calls * FRESH_INPUT_PER_CALL);
    const axisOutput = Math.round(profile.callRate * perPassOutput * profile.outputMultiplier);
    const axisCacheRead = Math.round(calls * profile.cacheReadPerCall);
    const axisCacheCreation = Math.round(calls * profile.contextPerCall + profile.callRate * sumFileTokens);
    const cost = calculateCost(axis.model, axisInput, axisOutput, projectRoot, {
      read: axisCacheRead,
      creation: axisCacheCreation,
      ttl: cacheWriteTtl(axis.model),
    });
    steps.push({
      category: 'axis',
      name: axis.id,
      model: axis.model,
      billingMode: resolveBillingMode(axis.model),
      inputTokens: axisInput,
      outputTokens: axisOutput,
      cacheReadTokens: axisCacheRead,
      cacheCreationTokens: axisCacheCreation,
      costUsd: cost,
    });
  }

  // Deliberation step: one deliberation-model call per shard. Shards are
  // built by `core/refinement/tier3.ts:buildShards`, which groups escalated
  // findings by `dirname(file)` — one shard per distinct directory, with
  // a 20-finding cap that splits oversized dirs.
  //
  // Approximation: shard count ≈ distinct directories among evalTasks,
  // floored at 1. We can't predict the escalation rate per file (which is
  // what really determines whether a directory yields a shard), but
  // empirically directories with reviewed files almost always produce at
  // least one escalation.
  //
  // Earlier versions used `ceil(E / 20)` which silently degenerated to 1
  // shard for any project under ~20 files regardless of structure — fine
  // for monolithic single-dir trees (slot-engine) but broke spectacularly
  // on multi-module projects: python-dotenv (18 files / 5 dirs) ran 5
  // real shards against 1 forecasted, under-pricing deliberation 5×.
  if (deliberation && deliberationModel && axes.length > 0 && E > 0) {
    const distinctDirs = new Set(evalTasks.map((t) => dirname(t.file))).size;
    const shardCount = Math.max(1, distinctDirs);
    const shard = DELIBERATION_SHARD_PROFILES[modelGeneration(deliberationModel)];
    const delibInput = shardCount * shard.input;
    const delibOutput = shardCount * shard.output;
    const delibCacheRead = shardCount * shard.cacheRead;
    const delibCacheCreation = shardCount * shard.cacheCreation;
    steps.push({
      category: 'deliberation',
      name: '',
      model: deliberationModel,
      billingMode: resolveBillingMode(deliberationModel),
      inputTokens: delibInput,
      outputTokens: delibOutput,
      cacheReadTokens: delibCacheRead,
      cacheCreationTokens: delibCacheCreation,
      costUsd: calculateCost(deliberationModel, delibInput, delibOutput, projectRoot, {
        read: delibCacheRead,
        creation: delibCacheCreation,
        ttl: cacheWriteTtl(deliberationModel),
      }),
      approximate: true,
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
      category: 'summary',
      name: '',
      model: summaryModel,
      billingMode: resolveBillingMode(summaryModel),
      inputTokens: summaryInput,
      outputTokens: summaryOutput,
      costUsd: calculateCost(summaryModel, summaryInput, summaryOutput, projectRoot),
    });
  }

  // Embed steps — one per axis (code, text). Surfaced even when local so the
  // user sees the work; cost is 0 when models have no pricing entry. The
  // public step name is `text` (matches the v3 config schema's
  // routing.embeddings.text); internal token fields stay `nlp*` because they
  // come from upstream pricing registries that haven't migrated yet.
  if (embed && embed.codeTokens > 0) {
    const cost = embed.codeModel
      ? calculateCost(embed.codeModel, embed.codeTokens, 0, projectRoot)
      : 0;
    steps.push({
      category: 'embed',
      name: 'code',
      model: embed.codeModel ?? 'local',
      billingMode: resolveBillingMode(embed.codeModel ?? 'local'),
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
      category: 'embed',
      name: 'text',
      model: embed.nlpModel ?? 'local',
      billingMode: resolveBillingMode(embed.nlpModel ?? 'local'),
      inputTokens: embed.nlpTokens,
      outputTokens: 0,
      costUsd: cost,
    });
  }

  // Internal-doc generation: heuristic per-page cost that models the multi-turn
  // agentic conversation with prompt caching. See DOC_*_PER_PAGE jsdoc for
  // the breakdown. Marked `approximate: true` so display can prefix `~`.
  if (docContext && docContext.pageCount > 0) {
    const c = docContext.mode === 'bootstrap' ? DOC_BOOTSTRAP_PER_PAGE : DOC_UPDATE_PER_PAGE;
    const docFresh = docContext.pageCount * c.fresh;
    const docCacheRead = docContext.pageCount * c.cacheRead;
    const docCacheCreation = docContext.pageCount * c.cacheCreation;
    const docOutput = docContext.pageCount * c.output;
    steps.push({
      category: 'internal-doc',
      name: docContext.mode,
      model: docContext.scaffoldingModel,
      billingMode: resolveBillingMode(docContext.scaffoldingModel),
      inputTokens: docFresh,
      outputTokens: docOutput,
      cacheReadTokens: docCacheRead,
      cacheCreationTokens: docCacheCreation,
      costUsd: calculateCost(docContext.scaffoldingModel, docFresh, docOutput, projectRoot, {
        read: docCacheRead,
        creation: docCacheCreation,
        ttl: cacheWriteTtl(docContext.scaffoldingModel),
      }),
      approximate: true,
    });

    // Coherence review — single-agent Sonnet pass after bootstrap that
    // reads all generated pages and rewrites them for cross-page coherence.
    // Only runs in bootstrap mode (see run.ts: `if (taskId === 'bootstrap-doc')`).
    // Without this step the forecast missed ~$2.77 on the R1 baseline (18-page
    // bootstrap of slot-engine), making total cost ~13× under-reported.
    if (docContext.mode === 'bootstrap') {
      const cc = DOC_COHERENCE_PER_PAGE;
      const cohFresh = docContext.pageCount * cc.fresh;
      const cohCacheRead = docContext.pageCount * cc.cacheRead;
      const cohCacheCreation = docContext.pageCount * cc.cacheCreation;
      const cohOutput = docContext.pageCount * cc.output;
      steps.push({
        category: 'internal-doc',
        name: 'coherence',
        model: docContext.scaffoldingModel,
        billingMode: resolveBillingMode(docContext.scaffoldingModel),
        inputTokens: cohFresh,
        outputTokens: cohOutput,
        cacheReadTokens: cohCacheRead,
        cacheCreationTokens: cohCacheCreation,
        costUsd: calculateCost(docContext.scaffoldingModel, cohFresh, cohOutput, projectRoot, {
          read: cohCacheRead,
          creation: cohCacheCreation,
          ttl: cacheWriteTtl(docContext.scaffoldingModel),
        }),
        approximate: true,
      });
    }
  }

  // Doc-conflict detection: single LLM call per run in full mode.
  // Uses the scaffolding model (or falls back to axes[0] model) to read
  // internal doc fragments and code anchors, then emits a structured
  // conflict list. Marked approximate since the real token shape depends
  // on the number of doc fragments.
  if (docConflictDetection) {
    const detectorModel = docContext?.scaffoldingModel ?? axes[0]?.model;
    if (detectorModel) {
      const ct = DOC_CONFLICT_DETECTOR_TOKENS;
      steps.push({
        category: 'internal-doc',
        name: 'conflict-detection',
        model: detectorModel,
        billingMode: resolveBillingMode(detectorModel),
        inputTokens: ct.input,
        outputTokens: ct.output,
        costUsd: calculateCost(detectorModel, ct.input, ct.output, projectRoot),
        approximate: true,
      });
    }
  }

  // Aggregate from steps — single source of truth: any new step type lands
  // in totals automatically.
  const llmSteps = steps.filter((s) => s.category !== 'embed');
  const embedSteps = steps.filter((s) => s.category === 'embed');

  const llmInputTokens = llmSteps.reduce((sum, s) => sum + s.inputTokens, 0);
  const llmOutputTokens = llmSteps.reduce((sum, s) => sum + s.outputTokens, 0);
  const llmCacheReadTokens = llmSteps.reduce((sum, s) => sum + (s.cacheReadTokens ?? 0), 0);
  const llmCacheCreationTokens = llmSteps.reduce((sum, s) => sum + (s.cacheCreationTokens ?? 0), 0);
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
      cacheReadTokens: llmCacheReadTokens,
      cacheCreationTokens: llmCacheCreationTokens,
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
