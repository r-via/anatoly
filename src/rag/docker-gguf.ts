// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * GGUF Docker container lifecycle — sequential (swap) mode.
 *
 * Only one model is loaded at a time to minimise VRAM usage (~10 GB instead
 * of ~20 GB).  When the caller switches between code and NLP embeddings the
 * active container is stopped and a new one is started with the other model.
 * The swap cost is the container startup time (30-120 s).
 */

import { execSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import {
  GGUF_DOCKER_IMAGE,
  GGUF_CODE_PORT,
  GGUF_NLP_PORT,
  GGUF_CODE_MODEL_FILE,
  GGUF_NLP_MODEL_FILE,
} from './hardware-detect.js';

const CONTAINER_PREFIX = 'anatoly-gguf';
/** Timeout for model loading in Docker containers (3 minutes). */
const READY_TIMEOUT_MS = 180_000;

type ActiveModel = 'code' | 'nlp' | null;

let activeModel: ActiveModel = null;
let modelsDirectory: string | null = null;
let logFn: ((message: string) => void) | undefined;
let progressFn: ((elapsed: number) => void) | undefined;
let dockerVerified = false;

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function removeContainer(name: string): void {
  try {
    execFileSync('docker', ['rm', '-f', name], {
      stdio: 'ignore',
      timeout: 10_000,
    });
  } catch {
    // Container doesn't exist — OK
  }
}

/**
 * Start a detached Docker container running llama.cpp in embedding-serving
 * mode with GPU pass-through (`--gpus all`, `--embedding`, `--pooling last`).
 * Any previous container with the same name is force-removed first.
 *
 * @param name - Docker container name (used for identification and cleanup).
 * @param modelFile - GGUF model filename relative to the mounted models directory.
 * @param hostPort - Host port mapped to the container's internal port 8080.
 */
function runContainer(name: string, modelFile: string, hostPort: number): void {
  removeContainer(name);

  const args = [
    'run',
    '--gpus', 'all',
    '-v', `${modelsDirectory}:/models:ro`,
    '-p', `${hostPort}:8080`,
    '--name', name,
    '-d',
    GGUF_DOCKER_IMAGE,
    '--model', `/models/${modelFile}`,
    '--embedding',
    '--pooling', 'last',
    '--port', '8080',
  ];

  execFileSync('docker', args, { encoding: 'utf-8', timeout: 30_000 });
}

/**
 * Poll a container's `/health` endpoint until it responds with HTTP 200 or
 * the overall timeout expires. Each individual fetch is aborted after 2 s to
 * avoid hanging on an unresponsive server, while the outer loop retries every
 * 1 s up to `timeoutMs` total elapsed time.
 *
 * @param port - Host port to poll (http://127.0.0.1:{port}/health).
 * @param timeoutMs - Maximum wall-clock time (ms) to wait before giving up.
 * @param onProgress - Optional callback invoked each second with elapsed seconds.
 * @returns `true` if the container became healthy, `false` if the timeout was reached.
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

// ---------------------------------------------------------------------------
// Swap logic
// ---------------------------------------------------------------------------

function modelConfig(model: 'code' | 'nlp') {
  return model === 'code'
    ? { file: GGUF_CODE_MODEL_FILE, port: GGUF_CODE_PORT, label: 'code', container: `${CONTAINER_PREFIX}-code` }
    : { file: GGUF_NLP_MODEL_FILE, port: GGUF_NLP_PORT, label: 'NLP', container: `${CONTAINER_PREFIX}-nlp` };
}

/**
 * Ensure the requested model is loaded. If a different model is active,
 * stop the current container and start a new one.  No-op if the requested
 * model is already running.
 */
export async function ensureModel(model: 'code' | 'nlp'): Promise<void> {
  if (!modelsDirectory) {
    throw new Error('modelsDirectory not initialised — call startGgufContainers() first');
  }

  if (activeModel === model) {
    // Verify the container is still alive
    try {
      const status = execFileSync('docker', ['inspect', '--format', '{{.State.Status}}', modelConfig(model).container], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (status === 'running') return;
      logFn?.(`GGUF ${model} container died (status=${status}) — restarting...`);
    } catch {
      logFn?.(`GGUF ${model} container not found — restarting...`);
    }
    activeModel = null;
  }

  const cfg = modelConfig(model);

  if (activeModel !== null) {
    const prev = modelConfig(activeModel);
    logFn?.(`swapping GGUF model: ${prev.label} → ${cfg.label}...`);
    removeContainer(prev.container);
    activeModel = null;
  }

  logFn?.(`starting GGUF ${cfg.label} container (port ${cfg.port})...`);
  runContainer(cfg.container, cfg.file, cfg.port);

  logFn?.(`waiting for GGUF ${cfg.label} model to load into VRAM...`);
  const ready = await waitForContainer(cfg.port, READY_TIMEOUT_MS, progressFn);

  if (!ready) {
    removeContainer(cfg.container);
    throw new Error(`GGUF ${cfg.label} container failed to become healthy`);
  }

  activeModel = model;
  logFn?.(`GGUF ${cfg.label} model ready`);
}

// ---------------------------------------------------------------------------
// Public lifecycle API (unchanged signatures for callers)
// ---------------------------------------------------------------------------

/**
 * Validate prerequisites for GGUF containers (model files, Docker daemon).
 * Starts the code model by default so the first embedCode() call is instant.
 *
 * @param projectRoot - Project root path (reserved for future per-project config).
 * @param onLog - Optional callback for status/error messages during startup.
 * @param onProgress - Optional callback invoked with elapsed seconds while waiting for readiness.
 * @returns `true` if the code-model container started and became healthy, `false` on any failure.
 */
export async function startGgufContainers(
  projectRoot: string,
  onLog?: (message: string) => void,
  onProgress?: (elapsed: number) => void,
): Promise<boolean> {
  modelsDirectory = resolve(homedir(), '.anatoly', 'models');
  logFn = onLog;
  progressFn = onProgress;

  // Verify model files exist
  const codeModelPath = resolve(modelsDirectory, GGUF_CODE_MODEL_FILE);
  const nlpModelPath = resolve(modelsDirectory, GGUF_NLP_MODEL_FILE);

  if (!existsSync(codeModelPath)) {
    onLog?.(`GGUF code model not found: ${codeModelPath} — run 'anatoly setup-embeddings' first`);
    return false;
  }
  if (!existsSync(nlpModelPath)) {
    onLog?.(`GGUF NLP model not found: ${nlpModelPath} — run 'anatoly setup-embeddings' first`);
    return false;
  }

  // Verify Docker daemon is running (once)
  if (!dockerVerified) {
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
      dockerVerified = true;
    } catch {
      onLog?.('Docker not available — cannot start GGUF containers');
      return false;
    }
  }

  // Kill zombie containers from previous runs (crash, Ctrl+C, etc.)
  try {
    const zombies = execFileSync(
      'docker', ['ps', '-aq', '--filter', 'name=anatoly-gguf'],
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    const ids = zombies.split('\n').filter(Boolean);
    if (ids.length > 0) {
      onLog?.('cleaning up leftover GGUF containers...');
      execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore', timeout: 10_000 });
    }
  } catch {
    // ignore cleanup errors
  }

  try {
    // Start with the code model (most common first call)
    await ensureModel('code');
    return true;
  } catch (err) {
    onLog?.(`GGUF container start failed: ${(err as Error).message}`);
    await stopGgufContainers(onLog);
    return false;
  }
}

/**
 * Stop and remove the active GGUF Docker container.
 * Safe to call even if no container is running — idempotent.
 */
export async function stopGgufContainers(
  onLog?: (message: string) => void,
): Promise<void> {
  // Remove both containers (whichever may be running)
  removeContainer(`${CONTAINER_PREFIX}-code`);
  removeContainer(`${CONTAINER_PREFIX}-nlp`);

  if (activeModel !== null) {
    onLog?.('GGUF container stopped');
  }
  activeModel = null;
}

/** Check if a GGUF container is currently managed by this process. */
export function areGgufContainersRunning(): boolean {
  return activeModel !== null;
}
