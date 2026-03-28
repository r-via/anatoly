// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Docker container lifecycle for HuggingFace Text Embeddings Inference (TEI).
 *
 * TEI is used only during setup (A/B test as fp16 reference).
 * At runtime, GGUF containers are preferred. This module exists as the
 * TypeScript counterpart to the shell docker-helpers.sh for any future
 * runtime TEI usage.
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isDockerAvailable, removeContainer, waitForContainer } from './docker-utils.js';

export const TEI_DOCKER_IMAGE = 'ghcr.io/huggingface/text-embeddings-inference:1.9';
export const TEI_CODE_PORT = 11435;
export const TEI_NLP_PORT = 11436;

const CONTAINER_PREFIX = 'anatoly-tei';
const CODE_CONTAINER = `${CONTAINER_PREFIX}-code`;
const NLP_CONTAINER = `${CONTAINER_PREFIX}-nlp`;
const READY_TIMEOUT_MS = 300_000; // TEI can take longer to download models

let containersStarted = false;

/**
 * Start a TEI container for a given model.
 * The model is downloaded by TEI on first run (cached in the data volume).
 */
function runContainer(
  name: string,
  modelId: string,
  hostPort: number,
  cacheDir?: string,
): void {
  removeContainer(name);

  const dataDir = cacheDir ?? `${process.env.HOME ?? homedir()}/.cache/huggingface`;
  const args = [
    'run',
    '--gpus', 'all',
    '-v', `${dataDir}:/data`,
    '-p', `${hostPort}:80`,
    '--name', name,
    '-d',
    TEI_DOCKER_IMAGE,
    '--model-id', modelId,
    '--dtype', 'float16',
    '--port', '80',
  ];

  execFileSync('docker', args, { encoding: 'utf-8', timeout: 30_000 });
}

/**
 * Start TEI Docker containers for code and NLP embedding.
 * Returns true if both containers are healthy, false on any failure.
 *
 * Note: TEI loads one model per container. Both run simultaneously but
 * require significant VRAM (~14-16 GB each for large models).
 * For A/B testing during setup, containers are started sequentially.
 */
export async function startTeiContainers(
  codeModel: string,
  nlpModel: string,
  onLog?: (message: string) => void,
  onProgress?: (elapsed: number) => void,
): Promise<boolean> {
  if (!isDockerAvailable()) {
    onLog?.('Docker not available — cannot start TEI containers');
    return false;
  }

  onLog?.(`starting TEI containers (code: ${TEI_CODE_PORT}, NLP: ${TEI_NLP_PORT})...`);

  try {
    runContainer(CODE_CONTAINER, codeModel, TEI_CODE_PORT);
    runContainer(NLP_CONTAINER, nlpModel, TEI_NLP_PORT);

    onLog?.('waiting for TEI models to load...');
    const [codeReady, nlpReady] = await Promise.all([
      waitForContainer(TEI_CODE_PORT, READY_TIMEOUT_MS, onProgress),
      waitForContainer(TEI_NLP_PORT, READY_TIMEOUT_MS),
    ]);

    if (!codeReady || !nlpReady) {
      const failed = [!codeReady && 'code', !nlpReady && 'NLP'].filter(Boolean).join(', ');
      onLog?.(`TEI containers failed to become healthy (${failed}) — cleaning up`);
      await stopTeiContainers(onLog);
      return false;
    }

    containersStarted = true;
    onLog?.('TEI containers ready — both models loaded');
    return true;
  } catch (err) {
    onLog?.(`TEI container start failed: ${(err as Error).message}`);
    await stopTeiContainers(onLog);
    return false;
  }
}

/**
 * Stop and remove TEI Docker containers.
 * Safe to call even if containers aren't running — idempotent.
 */
export async function stopTeiContainers(
  onLog?: (message: string) => void,
): Promise<void> {
  removeContainer(CODE_CONTAINER);
  removeContainer(NLP_CONTAINER);

  if (containersStarted) {
    onLog?.('TEI containers stopped');
  }
  containersStarted = false;
}

/** Check if TEI containers are currently managed by this process. */
export function areTeiContainersRunning(): boolean {
  return containersStarted;
}
