import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Task } from '../schemas/task.js';
import type { Config } from '../schemas/config.js';
import type { ReviewFile, BestPractices } from '../schemas/review.js';
import type { AxisContext, AxisEvaluator, AxisId, AxisResult, PreResolvedRag } from './axis-evaluator.js';
import type { UsageGraph } from './usage-graph.js';
import type { DependencyMeta } from './dependency-meta.js';
import { extractFileDeps } from './dependency-meta.js';
import type { VectorStore } from '../rag/vector-store.js';
import { buildFunctionId } from '../rag/indexer.js';
import { mergeAxisResults } from './axis-merger.js';
import { resolveDeliberationModel, runSingleTurnQuery } from './axis-evaluator.js';
import {
  DeliberationResponseSchema,
  buildDeliberationSystemPrompt,
  buildDeliberationUserMessage,
  needsDeliberation,
  applyDeliberation,
} from './deliberation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvaluateFileOptions {
  projectRoot: string;
  task: Task;
  config: Config;
  evaluators: AxisEvaluator[];
  abortController: AbortController;
  runDir: string;
  usageGraph?: UsageGraph;
  vectorStore?: VectorStore;
  ragEnabled?: boolean;
  depMeta?: DependencyMeta;
  projectTree?: string;
  deliberation?: boolean;
  onAxisComplete?: (axisId: AxisId) => void;
  /** Stream transcript chunks to disk as each axis completes. */
  onTranscriptChunk?: (chunk: string) => void;
}

export interface EvaluateFileResult {
  review: ReviewFile;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  transcript: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a single file through all enabled axis evaluators in parallel.
 *
 * 1. Reads the file content once
 * 2. Pre-resolves RAG similarity (if enabled)
 * 3. Executes all evaluators concurrently via Promise.allSettled
 * 4. Extracts best_practices data if present
 * 5. Merges results into a single ReviewFile v2
 * 6. Reports axis completion via callback
 */
export async function evaluateFile(opts: EvaluateFileOptions): Promise<EvaluateFileResult> {
  const { projectRoot, task, config, evaluators, abortController, usageGraph, onAxisComplete } = opts;

  const fileContent = readFileSync(resolve(projectRoot, task.file), 'utf-8');

  // Pre-resolve RAG for duplication axis
  const preResolvedRag = await preResolveRag(task, opts);

  const fileDeps = opts.depMeta ? extractFileDeps(fileContent, opts.depMeta) : undefined;

  const ctx: AxisContext = {
    task,
    fileContent,
    config,
    projectRoot,
    usageGraph,
    preResolvedRag,
    fileDeps,
    projectTree: opts.projectTree,
  };

  const startTime = Date.now();
  const transcriptParts: string[] = [];

  // Execute all evaluators in parallel
  const settledResults = await Promise.allSettled(
    evaluators.map(async (evaluator) => {
      const result = await evaluator.evaluate(ctx, abortController);
      onAxisComplete?.(evaluator.id);
      return result;
    }),
  );

  // Collect successful results, log failures — stream transcript chunks as available
  const successResults: AxisResult[] = [];
  const failedAxes: AxisId[] = [];
  for (let i = 0; i < settledResults.length; i++) {
    const settled = settledResults[i];
    const evaluator = evaluators[i];
    let chunk: string;
    if (settled.status === 'fulfilled') {
      successResults.push(settled.value);
      chunk = `# Axis: ${evaluator.id}\n\n${settled.value.transcript}\n`;
    } else {
      failedAxes.push(evaluator.id);
      chunk = `# Axis: ${evaluator.id} — FAILED\n\n${String(settled.reason)}\n`;
      process.stderr.write(`[warn] axis "${evaluator.id}" failed for ${task.file}: ${String(settled.reason)}\n`);
    }
    transcriptParts.push(chunk);
    opts.onTranscriptChunk?.(chunk + '\n---\n\n');
  }

  // Extract best_practices data from the dedicated evaluator
  let bestPractices: BestPractices | undefined;
  for (const r of successResults) {
    if (r.axisId === 'best_practices') {
      const bpResult = r as AxisResult & { _bestPractices?: BestPractices };
      if (bpResult._bestPractices) {
        bestPractices = bpResult._bestPractices;
      }
    }
  }

  let totalCost = successResults.reduce((sum, r) => sum + r.costUsd, 0);
  let totalInputTokens = successResults.reduce((sum, r) => sum + r.inputTokens, 0);
  let totalOutputTokens = successResults.reduce((sum, r) => sum + r.outputTokens, 0);
  let totalCacheReadTokens = successResults.reduce((sum, r) => sum + r.cacheReadTokens, 0);
  let totalCacheCreationTokens = successResults.reduce((sum, r) => sum + r.cacheCreationTokens, 0);

  let review = mergeAxisResults(task, successResults, bestPractices, failedAxes);

  // --- Deliberation pass (optional) ---
  if (opts.deliberation && config.llm.deliberation) {
    if (needsDeliberation(review)) {
      try {
        const deliberationModel = resolveDeliberationModel(config);
        const deliberationResult = await runSingleTurnQuery(
          {
            systemPrompt: buildDeliberationSystemPrompt(),
            userMessage: buildDeliberationUserMessage(review, fileContent),
            model: deliberationModel,
            projectRoot,
            abortController,
          },
          DeliberationResponseSchema,
        );

        review = applyDeliberation(review, deliberationResult.data);
        totalCost += deliberationResult.costUsd;
        totalInputTokens += deliberationResult.inputTokens;
        totalOutputTokens += deliberationResult.outputTokens;
        totalCacheReadTokens += deliberationResult.cacheReadTokens;
        totalCacheCreationTokens += deliberationResult.cacheCreationTokens;
        const delibChunk = `# Deliberation Pass\n\n${deliberationResult.transcript}\n`;
        transcriptParts.push(delibChunk);
        opts.onTranscriptChunk?.(delibChunk);
      } catch (err) {
        const failChunk = `# Deliberation Pass — FAILED\n\n${String(err)}\n`;
        transcriptParts.push(failChunk);
        opts.onTranscriptChunk?.(failChunk);
        process.stderr.write(`[warn] deliberation failed for ${task.file}: ${String(err)}\n`);
      }
    } else {
      const skipChunk = '# Deliberation Pass — SKIPPED\n\nFile is CLEAN with high confidence.\n';
      transcriptParts.push(skipChunk);
      opts.onTranscriptChunk?.(skipChunk);
    }
  }

  const totalDuration = Date.now() - startTime;
  const transcript = transcriptParts.join('\n---\n\n');

  return {
    review,
    costUsd: totalCost,
    durationMs: totalDuration,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    transcript,
  };
}

// ---------------------------------------------------------------------------
// RAG pre-resolution (moved from reviewer.ts)
// ---------------------------------------------------------------------------

async function preResolveRag(task: Task, opts: EvaluateFileOptions): Promise<PreResolvedRag | undefined> {
  if (!opts.ragEnabled || !opts.vectorStore) return undefined;

  const functionSymbols = task.symbols.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
  );

  const preResolved: PreResolvedRag = [];
  for (const symbol of functionSymbols) {
    const functionId = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
    try {
      const results = await opts.vectorStore.searchById(functionId);
      preResolved.push({ symbolName: symbol.name, lineStart: symbol.line_start, lineEnd: symbol.line_end, results });
    } catch {
      preResolved.push({ symbolName: symbol.name, lineStart: symbol.line_start, lineEnd: symbol.line_end, results: null });
    }
  }

  return preResolved.length > 0 ? preResolved : undefined;
}
