import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Task } from '../schemas/task.js';
import type { Config } from '../schemas/config.js';
import type { ReviewFile, BestPractices } from '../schemas/review.js';
import type { AxisContext, AxisEvaluator, AxisId, AxisResult, PreResolvedRag } from './axis-evaluator.js';
import type { UsageGraph } from './usage-graph.js';
import type { VectorStore } from '../rag/vector-store.js';
import { buildFunctionId } from '../rag/indexer.js';
import { mergeAxisResults } from './axis-merger.js';

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
  onAxisComplete?: (axisId: AxisId) => void;
}

export interface EvaluateFileResult {
  review: ReviewFile;
  costUsd: number;
  durationMs: number;
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

  const ctx: AxisContext = {
    task,
    fileContent,
    config,
    usageGraph,
    preResolvedRag,
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

  // Collect successful results, log failures
  const successResults: AxisResult[] = [];
  for (let i = 0; i < settledResults.length; i++) {
    const settled = settledResults[i];
    const evaluator = evaluators[i];
    if (settled.status === 'fulfilled') {
      successResults.push(settled.value);
      transcriptParts.push(`# Axis: ${evaluator.id}\n\n${settled.value.transcript}\n`);
    } else {
      transcriptParts.push(`# Axis: ${evaluator.id} — FAILED\n\n${String(settled.reason)}\n`);
    }
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

  const totalCost = successResults.reduce((sum, r) => sum + r.costUsd, 0);
  const totalDuration = Date.now() - startTime;
  const transcript = transcriptParts.join('\n---\n\n');

  const review = mergeAxisResults(task, successResults, bestPractices);

  return { review, costUsd: totalCost, durationMs: totalDuration, transcript };
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
