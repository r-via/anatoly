// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Rag-index phase (extracted from run.ts in PR 4, doc 11 Strategy B).
 *
 * Move-only: the body is the verbatim `runRagPhase` from run.ts. Forced
 * edits only: the `export` keyword, and inline dynamic-import paths
 * (`import('../rag/...')` -> `import('../../../rag/...')`) rebased for the
 * new module depth.
 *
 * Returns `RagContext` from the typed handoff contract (handoff.ts). The one
 * run.ts-local helper it used, `recordLlmCost`, was relocated to
 * orchestration/cost.ts. `RunContext` is type-only (erased): no runtime
 * cycle, no commands-layer dependency. Import list seeded from run.ts's
 * (path-rewritten) then pruned to actual needs.
 *
 * Post-PR-8 state (doc 11): the orchestration spine lives in
 * pipeline.ts (PR 8a), not run.ts; this phase receives the typed
 * `Handoff` object explicitly as a parameter (PR 8c) and the §4
 * inter-phase data is no longer `ctx` mutation. Any line above
 * describing a run.ts call site, `ctx`-mutation, or "handoff
 * untouched until PR 8" is extraction-era history, superseded here.
 */

import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { getV3Source } from '../../../utils/config-loader.js';
import { getDocsDir } from '../../../schemas/config.js';
import { releaseLock } from '../../../utils/lock.js';
import { AnatolyError, ERROR_CODES } from '../../../utils/errors.js';
import { indexProject, type RagIndexResult } from '../../../rag/index.js';
import { detectHardware, resolveEmbeddingModels, readEmbeddingsReadyFlag, determineBackend, type EmbeddingBackend } from '../../../rag/hardware-detect.js';
import { startGgufContainers, stopGgufContainers, setGgufWaitProgressHandler } from '../../../rag/docker-gguf.js';
import { stopTeiContainers } from '../../../rag/docker-tei.js';
import { getLogger } from '../../../utils/logger.js';
import type { Task } from '../../../schemas/task.js';
import { resolveCodeSummaryModel } from '../../evaluation/index.js';
import { shortModelName } from '../../../cli/setup-table.js';
import { recordRagCost } from '../cost.js';
import type { RagContext, Handoff } from '../handoff.js';
import type { OrchestrationEventName } from '../events.js';
import type { RunContext } from '../../../commands/run.js';

export async function runRagPhase(ctx: RunContext, handoff: Handoff, tasks: Task[]): Promise<RagContext> {
  if (!ctx.enableRag) return { ragEnabled: false };

  const log = getLogger();
  const rl = ctx.runLog;
  const ragStart = Date.now();

  // Detect hardware and determine backend BEFORE starting any embedding server
  const hardware = detectHardware();
  const readyFlag = readEmbeddingsReadyFlag(ctx.projectRoot);
  const logFn = ctx.verbose ? (msg: string) => { log.debug(msg); } : undefined;
  let effectiveBackend: EmbeddingBackend = determineBackend(readyFlag, hardware, ctx.config);

  // Unified "In progress" activity for the GGUF setup phase: container
  // startup → connectivity check → (any pre_hook-driven swap). One synthetic
  // activeFile entry whose path evolves with the current step, and whose
  // retryMsg carries the live elapsed-second counter from VRAM loads or the
  // latest probe log line. Without this, the spinner would freeze for tens of
  // seconds during VRAM swaps and look like the app is hung.
  const tuiActive = !ctx.plain && process.stdout.isTTY && !!ctx.pipelineState;
  let activityLabel: string | null = null;
  const setActivity = (label: string) => {
    if (!tuiActive) return;
    if (activityLabel) ctx.pipelineState!.activeFiles.delete(activityLabel);
    activityLabel = label;
    ctx.pipelineState!.trackFile(label);
  };
  const setActivityDetail = (detail: string) => {
    if (!tuiActive || !activityLabel) return;
    ctx.pipelineState!.setRetryMessage(activityLabel, detail);
  };
  const clearActivity = () => {
    if (activityLabel && ctx.pipelineState) {
      ctx.pipelineState.activeFiles.delete(activityLabel);
    }
    activityLabel = null;
  };

  try {
    // Handler fires every second while a GGUF container is loading its
    // model into VRAM (initial start AND swaps triggered by the SDK
    // pre_hook). Installed for the whole setup phase and cleared in
    // `finally` below.
    setGgufWaitProgressHandler((model, elapsed) => {
      setActivityDetail(`loading ${model} model · ${elapsed}s`);
    });

    // Start the appropriate embedding backend based on detected tier
    if (effectiveBackend === 'advanced-gguf' && ctx.resolvedRagMode === 'advanced') {
      const ggufMsg = 'starting GGUF Docker containers';
      if (tuiActive) {
        setActivity(`${ggufMsg}…`);
      } else {
        log.info(ggufMsg);
      }
      const started = await startGgufContainers(ctx.projectRoot, logFn);
      if (!started) {
        if (ctx.rebuildRag) {
          log.warn('GGUF containers failed — falling back to ONNX lite (rebuild mode: full re-index)');
          effectiveBackend = 'lite';
        } else {
          throw new Error(
            'Docker is unavailable but this project was set up with advanced-gguf embeddings. '
            + 'Falling back to lite mode would produce incompatible embedding dimensions and corrupt the vector store. '
            + 'Please either:\n'
            + '  1. Start Docker and retry, or\n'
            + '  2. Run with --rebuild-rag to re-index everything in lite mode',
          );
        }
      }
      // Startup is done; clear the "starting GGUF…" activity so the spinner
      // doesn't linger with a misleading label through the rest of setup.
      clearActivity();
    }

    // Resolve models with the effective backend (handles GGUF/ONNX routing)
    const effectiveFlag = readyFlag
      ? { ...readyFlag, backend: effectiveBackend }
      : { device: 'cpu', backend: effectiveBackend } as import('../../../rag/hardware-detect.js').EmbeddingsReadyFlag;
    handoff.resolvedModels = await resolveEmbeddingModels(ctx.config.rag, hardware, logFn, effectiveFlag, getV3Source(ctx.config));

    // Pre-flight: probe the resolved backend before the indexer starts so a
    // misconfigured external provider (bad key, wrong base URL, unknown model)
    // fails in seconds with an actionable message instead of mid-pipeline.
    // Lite and advanced-gguf are no-op (advanced-gguf is already validated by
    // startGgufContainers — daemon, model files, container health). Suppressed
    // via --no-connectivity-check for deterministic CI runs.
    if (ctx.connectivityCheck) {
      const { runConnectivityCheck } = await import('../../../rag/connectivity-check.js');
      if (tuiActive && effectiveBackend === 'external') {
        setActivity('checking embedding backend…');
      }
      const probeLog = (msg: string) => {
        log.info(msg);
        rl?.info(msg);
        ctx.renderer?.logPlain(`[rag] ${msg}`);
        // Surface the latest probe log line in the In progress zone (only
        // matters for `external` — the other backends are instant no-ops).
        setActivityDetail(msg.trim().slice(0, 80));
      };
      const outcome = await runConnectivityCheck(handoff.resolvedModels, probeLog);
      if (!outcome.ok) {
        const { axis, provider, model, cause } = outcome.failure;
        const providerLabel = provider ?? '<no provider>';
        throw new AnatolyError(
          `RAG ${outcome.backend} connectivity check failed on ${axis} axis `
          + `(${providerLabel}/${model}): ${cause.message}`,
          ERROR_CODES.PROVIDER_AUTH_FAILED,
          false,
          outcome.backend === 'external'
            ? `verify the API key env var, base_url, and model name in .anatoly.yml; `
              + `pass --no-connectivity-check to bypass this gate`
            : `check that Docker is running and that GGUF setup completed; `
              + `re-run \`anatoly local-embeddings upgrade\` if needed`,
        );
      }
    }
  } finally {
    setGgufWaitProgressHandler(undefined);
    clearActivity();
  }

  // Update task labels with resolved model names
  const state = ctx.pipelineState!;
  const codeModel = shortModelName(handoff.resolvedModels.codeModel);
  const nlpModel = shortModelName(handoff.resolvedModels.nlpModel);
  const indexModel = resolveCodeSummaryModel(ctx.config);
  const llmModel = shortModelName(indexModel);
  state.relabelTask('rag-code', `Embedding code (${codeModel})`);
  state.relabelTask('rag-nlp', `LLM summaries (${llmModel}) & embedding (${nlpModel})`);
  state.relabelTask('rag-doc-project', `Chunking & embedding project docs (${nlpModel})`);
  state.relabelTask('rag-doc-internal', `Chunking & embedding internal docs (${nlpModel})`);

  let ragResult: RagIndexResult | undefined;
  const ragLogPath = join(ctx.runDir, 'logs', 'rag-index.log');
  mkdirSync(join(ctx.runDir, 'logs'), { recursive: true });
  const ragLogStream = createWriteStream(ragLogPath, { flags: 'a' });
  let ragPhase = 'code';
  const ragPhaseToTaskId: Record<string, string> = {
    code: 'rag-code',
    nlp: 'rag-nlp',
    upsert: 'rag-upsert',
    'doc-project': 'rag-doc-project',
    'doc-internal': 'rag-doc-internal',
  };

  state.startTask('rag-code', '0/?');

  try {
    ragResult = await indexProject({
      projectRoot: ctx.projectRoot,
      tasks,
      rebuild: ctx.rebuildRag,
      rebuildOnDrift: getV3Source(ctx.config)?.runtime.rag.rebuild_on_drift ?? true,
      concurrency: ctx.concurrency,
      verbose: ctx.verbose,
      indexModel,
      resolvedModels: handoff.resolvedModels,
      ragMode: ctx.resolvedRagMode,
      docsDir: getDocsDir(ctx.config),
      // Pass the actual `documentation.reference.paths` globs so the indexer
      // can pick up root-level files (README.md, ARCHITECTURE.md, etc.) that
      // fall outside the single derived `docsDir`. Empty falls back to
      // `docsDir` globbing.
      referencePaths: ctx.config.documentation?.reference?.paths ?? [],
      onLog: (msg) => {
        ctx.runLog?.debug({ phase: 'rag-index' }, msg);
        ragLogStream.write(`${new Date().toISOString()} ${msg}\n`);
        ctx.renderer?.logPlain(`[rag] ${msg}`);
      },
      onProgress: (current, total) => {
        const taskId = ragPhaseToTaskId[ragPhase];
        if (taskId) state.updateTask(taskId, `${current}/${total}`);
        // Surface progress in the ndjson event stream so `anatoly runs attach`
        // can render a meaningful counter during rag-index — otherwise the
        // attach status line is stuck at `0/<totalFiles>` for the whole phase
        // (file_review_end events only fire later, during the review phase).
        ctx.runLog?.info({
          event: ('rag_progress' satisfies OrchestrationEventName),
          phase: 'rag-index',
          subphase: ragPhase,
          current,
          total,
        }, 'rag progress');
      },
      onPhase: (phase) => {
        const prevTaskId = ragPhaseToTaskId[ragPhase];
        const nextTaskId = ragPhaseToTaskId[phase];
        ragPhase = phase;
        // Complete previous phase task with interim detail —
        // doc tasks get their final detail from ragResult after indexing completes
        if (prevTaskId && prevTaskId !== nextTaskId) {
          const interimDetail = prevTaskId.startsWith('rag-doc-') ? '…' : 'done';
          state.completeTask(prevTaskId, interimDetail);
          // Remove upsert synthetic file when leaving upsert phase
          if (prevTaskId === 'rag-upsert') {
            state.activeFiles.delete('Saving index\u2026');
          }
        }
        // Start next phase task
        if (nextTaskId) {
          state.startTask(nextTaskId);
          // During upsert, show synthetic file entry
          if (phase === 'upsert') {
            state.trackFile('Saving index\u2026');
          }
        }
      },
      onFileStart: (file) => { state.trackFile(file); },
      onFileDone: (file) => { state.untrackFile(file); },
      isInterrupted: () => ctx.interrupted,
      conversationDir: join(ctx.runDir, 'conversations'),
      router: ctx.router,
      fileFilter: ctx.fileFilter ?? undefined,
    });
  } finally {
    ragLogStream.end();
    // Free GPU/VRAM immediately — review uses pre-computed vectors from LanceDB.
    await stopGgufContainers(logFn);
    await stopTeiContainers();
  }

  // Complete final RAG phase task
  const finalTaskId = ragPhaseToTaskId[ragPhase];
  if (finalTaskId) {
    state.completeTask(finalTaskId, finalTaskId === 'rag-upsert' ? 'done' : (state.tasks.find((t) => t.id === finalTaskId)?.detail ?? 'done'));
  }
  // Remove upsert synthetic file
  state.activeFiles.delete('Saving index\u2026');

  // Set final completion details on all rag tasks
  if (ragResult) {
    state.completeTask('rag-code', `${ragResult.totalCards} functions (${ragResult.totalFiles} files)`);
    const nlpTask = state.tasks.find(t => t.id === 'rag-nlp');
    state.completeTask('rag-nlp', nlpTask?.status === 'pending' ? 'cached' : `${ragResult.totalCards} cards`);
    state.completeTask('rag-upsert', 'done');
    state.completeTask('rag-doc-project', ragResult.docsIdentical
      ? 'deduplicated (= internal)'
      : ragResult.projectDocSections > 0
        ? `${ragResult.projectDocSections} sections` : ragResult.projectDocsCached ? 'cached' : 'no project docs');
    state.completeTask('rag-doc-internal', ragResult.internalDocSections > 0
      ? `${ragResult.internalDocSections} sections` : ragResult.internalDocsCached ? 'cached' : 'no internal docs');
  }

  const ragDuration = Date.now() - ragStart;

  if (ctx.interrupted) {
    console.log('interrupted — rag indexing incomplete');
    if (ctx.lockPath) { releaseLock(ctx.lockPath); ctx.lockPath = undefined; }
    return { ragEnabled: false };
  }

  // Aggregate RAG LLM costs (NLP summaries + doc chunking). Provider is
  // anthropic — RAG NLP summarization runs through the same router.
  if (ragResult?.costUsd) {
    recordRagCost(ctx, { costUsd: ragResult.costUsd, durationMs: ragDuration });
  }

  // Store dedup status for project docs sync after internal docs update
  if (ragResult?.docsIdentical) {
    ctx.docsIdentical = true;
  }

  log.info({
    phase: 'rag-index', runId: ctx.runId, durationMs: ragDuration,
    cardsGenerated: ragResult?.cardsIndexed ?? 0, cached: (ragResult?.totalCards ?? 0) - (ragResult?.cardsIndexed ?? 0),
    costUsd: ragResult?.costUsd ?? 0,
  }, 'rag-index details');
  rl?.info({
    phase: 'rag-index', durationMs: ragDuration,
    cardsGenerated: ragResult?.cardsIndexed ?? 0,
    costUsd: ragResult?.costUsd ?? 0,
  }, 'rag-index details');

  if (ragResult) {
    return { ragEnabled: true, vectorStore: ragResult.vectorStore };
  }
  return { ragEnabled: false };
}
