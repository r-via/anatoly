// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Standalone RAG indexing — callable outside of `anatoly run`.
 *
 * Handles hardware detection, Docker container lifecycle, model resolution,
 * and delegates to the indexProject() orchestrator. Cleans up containers
 * on completion or failure.
 */

import { loadConfig } from '../utils/config-loader.js';
import { detectHardware, resolveEmbeddingModels, readEmbeddingsReadyFlag, determineBackend, type EmbeddingBackend, type EmbeddingsReadyFlag } from './hardware-detect.js';
import { startGgufContainers, stopGgufContainers } from './docker-gguf.js';
import { stopTeiContainers } from './docker-tei.js';
import { indexProject, type RagIndexResult } from './orchestrator.js';
import type { Task } from '../schemas/task.js';
import type { Semaphore } from '../core/sdk-semaphore.js';

export interface StandaloneRagOptions {
  projectRoot: string;
  tasks: Task[];
  rebuild?: boolean;
  docsDir?: string;
  onLog?: (msg: string) => void;
  onProgress?: (current: number, total: number) => void;
  onPhase?: (phase: string) => void;
  onFileStart?: (file: string) => void;
  onFileDone?: (file: string) => void;
  isInterrupted?: () => boolean;
  conversationDir?: string;
  semaphore?: Semaphore;
}

/**
 * Resolve the RAG table name for the current hardware/config.
 * Use this to open VectorStore with the correct table outside of indexing.
 */
export function resolveRagTableName(projectRoot: string): string {
  const hardware = detectHardware();
  const readyFlag = readEmbeddingsReadyFlag(projectRoot);
  const backend = determineBackend(readyFlag, hardware);
  const mode = backend === 'advanced-gguf' ? 'advanced' : 'lite';
  return `function_cards_${mode}`;
}

/**
 * Run RAG indexing as a standalone operation (outside of `anatoly run`).
 *
 * Detects hardware capabilities, starts GGUF Docker containers when advanced
 * mode is available, resolves embedding models, and delegates to
 * {@link indexProject}. If GGUF containers fail to start, the function
 * silently falls back to ONNX lite mode. GGUF and TEI containers are
 * unconditionally stopped in the `finally` block regardless of the active
 * backend.
 *
 * @param opts - Configuration and callbacks for the indexing run
 *               (see {@link StandaloneRagOptions}).
 * @returns The {@link RagIndexResult} produced by the underlying orchestrator.
 */
export async function indexProjectStandalone(opts: StandaloneRagOptions): Promise<RagIndexResult> {
  const {
    projectRoot,
    tasks,
    rebuild = false,
    docsDir,
    onLog = () => {},
    onProgress,
    onPhase,
    onFileStart,
    onFileDone,
    isInterrupted = () => false,
    conversationDir,
    semaphore,
  } = opts;

  const config = loadConfig(projectRoot);
  const hardware = detectHardware();
  const readyFlag = readEmbeddingsReadyFlag(projectRoot);
  let effectiveBackend: EmbeddingBackend = determineBackend(readyFlag, hardware);

  // Start GGUF containers if advanced mode
  if (effectiveBackend === 'advanced-gguf') {
    onLog('starting GGUF Docker containers…');
    const started = await startGgufContainers(projectRoot, onLog);
    if (!started) {
      if (rebuild) {
        onLog('GGUF containers failed — falling back to ONNX lite (rebuild mode: full re-index)');
        effectiveBackend = 'lite';
      } else {
        throw new Error(
          'Docker is unavailable but this project was set up with advanced-gguf embeddings. '
          + 'Falling back to lite mode would produce incompatible embedding dimensions and corrupt the vector store. '
          + 'Please either:\n'
          + '  1. Start Docker and retry, or\n'
          + '  2. Run with --rebuild to re-index everything in lite mode',
        );
      }
    }
  }

  // Resolve embedding models
  const effectiveFlag = readyFlag
    ? { ...readyFlag, backend: effectiveBackend }
    : { device: 'cpu', backend: effectiveBackend } as EmbeddingsReadyFlag;
  const resolvedModels = await resolveEmbeddingModels(config.rag, hardware, onLog, effectiveFlag);

  const ragMode = effectiveBackend === 'advanced-gguf' ? 'advanced' : 'lite';

  try {
    return await indexProject({
      projectRoot,
      tasks,
      rebuild,
      concurrency: config.llm.concurrency,
      indexModel: config.llm.index_model,
      resolvedModels,
      ragMode: ragMode as 'lite' | 'advanced',
      docsDir: docsDir ?? config.documentation?.docs_path ?? 'docs',
      onLog,
      onProgress,
      onPhase,
      onFileStart,
      onFileDone,
      isInterrupted,
      conversationDir,
      semaphore,
    });
  } finally {
    await stopGgufContainers(onLog);
    await stopTeiContainers();
  }
}
