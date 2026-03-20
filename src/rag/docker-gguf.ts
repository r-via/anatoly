// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { execSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  GGUF_DOCKER_IMAGE,
  GGUF_CODE_PORT,
  GGUF_NLP_PORT,
  GGUF_CODE_MODEL_FILE,
  GGUF_NLP_MODEL_FILE,
} from './hardware-detect.js';

const CONTAINER_PREFIX = 'anatoly-gguf';
const CODE_CONTAINER = `${CONTAINER_PREFIX}-code`;
const NLP_CONTAINER = `${CONTAINER_PREFIX}-nlp`;
/** Timeout for model loading in Docker containers (3 minutes). */
const READY_TIMEOUT_MS = 180_000;

let containersStarted = false;

/**
 * Remove a Docker container by name (running or stopped).
 * No-op if the container doesn't exist.
 */
function removeContainer(name: string): void {
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    // Container doesn't exist — OK
  }
}

/**
 * Start a single GGUF Docker container for embedding.
 * Runs detached, mapping the host port to the container's internal port 8080.
 */
function runContainer(
  name: string,
  modelsDir: string,
  modelFile: string,
  hostPort: number,
): void {
  removeContainer(name);

  const args = [
    'run',
    '--gpus', 'all',
    '-v', `${modelsDir}:/models`,
    '-p', `${hostPort}:8080`,
    '--name', name,
    '-d',
    GGUF_DOCKER_IMAGE,
    '--model', `/models/${modelFile}`,
    '--embedding',
    '--port', '8080',
  ];

  execFileSync('docker', args, { encoding: 'utf-8', timeout: 30_000 });
}

/**
 * Wait for a container's /health endpoint to respond OK.
 * GGUF models can take 30-120s to load into VRAM.
 */
async function waitForContainer(
  port: number,
  timeoutMs: number,
  onProgress?: (elapsed: number) => void,
): Promise<boolean> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/health`;

  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    onProgress?.(elapsed);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Start GGUF Docker containers for code and NLP embedding.
 * Both models are loaded simultaneously (~10 GB VRAM total).
 * Returns true if both containers are healthy, false on any failure.
 *
 * On failure, containers are cleaned up automatically.
 * Falls back gracefully — caller should try fp16 or lite.
 */
export async function startGgufContainers(
  projectRoot: string,
  onLog?: (message: string) => void,
  onProgress?: (elapsed: number) => void,
): Promise<boolean> {
  const modelsDir = resolve(projectRoot, '.anatoly', 'models');

  // Verify model files exist
  const codeModelPath = resolve(modelsDir, GGUF_CODE_MODEL_FILE);
  const nlpModelPath = resolve(modelsDir, GGUF_NLP_MODEL_FILE);

  if (!existsSync(codeModelPath)) {
    onLog?.(`GGUF code model not found: ${codeModelPath} — run 'anatoly setup-embeddings' first`);
    return false;
  }
  if (!existsSync(nlpModelPath)) {
    onLog?.(`GGUF NLP model not found: ${nlpModelPath} — run 'anatoly setup-embeddings' first`);
    return false;
  }

  // Verify Docker daemon is running
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
  } catch {
    onLog?.('Docker not available — cannot start GGUF containers');
    return false;
  }

  onLog?.(`starting GGUF containers (code: ${GGUF_CODE_PORT}, NLP: ${GGUF_NLP_PORT})...`);

  try {
    // Start both containers simultaneously
    runContainer(CODE_CONTAINER, modelsDir, GGUF_CODE_MODEL_FILE, GGUF_CODE_PORT);
    runContainer(NLP_CONTAINER, modelsDir, GGUF_NLP_MODEL_FILE, GGUF_NLP_PORT);

    // Wait for both to become healthy (model loading can take 30-120s)
    onLog?.('waiting for GGUF models to load into VRAM...');
    const [codeReady, nlpReady] = await Promise.all([
      waitForContainer(GGUF_CODE_PORT, READY_TIMEOUT_MS, onProgress),
      waitForContainer(GGUF_NLP_PORT, READY_TIMEOUT_MS),
    ]);

    if (!codeReady || !nlpReady) {
      const failed = [!codeReady && 'code', !nlpReady && 'NLP'].filter(Boolean).join(', ');
      onLog?.(`GGUF containers failed to become healthy (${failed}) — cleaning up`);
      await stopGgufContainers(onLog);
      return false;
    }

    containersStarted = true;
    onLog?.('GGUF containers ready — both models loaded');
    return true;
  } catch (err) {
    onLog?.(`GGUF container start failed: ${(err as Error).message}`);
    await stopGgufContainers(onLog);
    return false;
  }
}

/**
 * Stop and remove GGUF Docker containers.
 * Safe to call even if containers aren't running — idempotent.
 */
export async function stopGgufContainers(
  onLog?: (message: string) => void,
): Promise<void> {
  removeContainer(CODE_CONTAINER);
  removeContainer(NLP_CONTAINER);

  if (containersStarted) {
    onLog?.('GGUF containers stopped');
  }
  containersStarted = false;
}

/** Check if GGUF containers are currently managed by this process. */
export function areGgufContainersRunning(): boolean {
  return containersStarted;
}
