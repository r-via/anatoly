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
import { existsSync } from 'node:fs';
import { anatolyPath } from '../utils/anatoly-paths.js';
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
let waitProgressFn: ((model: 'code' | 'nlp', elapsed: number) => void) | undefined;
let dockerVerified = false;

/**
 * Register a callback invoked once per second while a GGUF container is
 * loading its model into VRAM (during initial start or a swap). Lets the
 * caller render live feedback in the CLI's "In progress" zone instead of
 * leaving the spinner frozen for tens of seconds.
 *
 * Pass `undefined` to clear.
 */
export function setGgufWaitProgressHandler(
  cb: ((model: 'code' | 'nlp', elapsed: number) => void) | undefined,
): void {
  waitProgressFn = cb;
}

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
 * Force-remove any `anatoly-*` container (other than `keepName`) currently
 * publishing the given host port. Used right before `docker run` to clear
 * leftovers from a crashed prior run that would otherwise win the port bind
 * race and leave the freshly-started container in an unhealthy state.
 *
 * Best-effort and silent on failure — at worst the subsequent `docker run`
 * will report a clear "port already allocated" error of its own.
 */
function removeOtherAnatolyContainersOnPort(keepName: string, hostPort: number): void {
  let output: string;
  try {
    output = execFileSync(
      'docker',
      ['ps', '-a', '--filter', 'name=anatoly-', '--format', '{{.Names}}\t{{.Ports}}'],
      { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'ignore'] },
    );
  } catch {
    return;
  }
  const portMarker = `:${hostPort}->`;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [containerName, ports = ''] = line.split('\t');
    if (!containerName || containerName === keepName) continue;
    if (!ports.includes(portMarker)) continue;
    try {
      execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 10_000 });
      logFn?.(`removed stale anatoly container on port ${hostPort}: ${containerName}`);
    } catch { /* best-effort */ }
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
  // Belt-and-suspenders: also remove any *other* anatoly-gguf-* container that
  // might be holding the same port. Leftovers from a crashed prior run, or
  // a sibling debug container, would otherwise block `docker run -p hostPort:8080`
  // before llama.cpp ever gets a chance to start, surfacing only as a stale
  // "container failed to become healthy" timeout.
  removeOtherAnatolyContainersOnPort(name, hostPort);

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
    // Match the bash setup script (scripts/lib/docker-helpers.sh): bind to
    // 0.0.0.0 explicitly and offload every layer to GPU. llama.cpp's default
    // listen address has flipped between releases, and without -ngl 999 it
    // may load partly on CPU on some image tags — both flags removed an
    // observed gap between "setup smoke test passes" and "runtime fails".
    '--host', '0.0.0.0',
    '-ngl', '999',
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
  // Lazy-init modelsDirectory if startGgufContainers was never called.
  // Without this, `-v null:/models:ro` quietly creates an empty docker volume
  // named "null"; llama.cpp can't find the .gguf file and exits 1 with a
  // misleading "container failed to become healthy" timeout at the call site.
  if (modelsDirectory === null) {
    modelsDirectory = anatolyPath(process.cwd(), 'shared/models/gguf');
    logFn?.(`modelsDirectory not initialised — defaulting to ${modelsDirectory}`);
  }
  // Fail fast with a clear message if the model file isn't where we expect it.
  const expectedFile = resolve(modelsDirectory, modelConfig(model).file);
  if (!existsSync(expectedFile)) {
    throw new Error(
      `GGUF ${model} model file missing: ${expectedFile}. ` +
      `Run 'anatoly local-embeddings upgrade' to download it.`,
    );
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
  const ready = await waitForContainer(
    cfg.port,
    READY_TIMEOUT_MS,
    (elapsed) => waitProgressFn?.(model, elapsed),
  );

  if (!ready) {
    // Capture diagnostics before tearing the container down — the bare
    // "failed to become healthy" message used to send users hunting blind.
    let containerLogs = '';
    let inspectStatus = '';
    try {
      containerLogs = execFileSync('docker', ['logs', '--tail', '30', cfg.container], {
        encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* container may already be gone */ }
    try {
      inspectStatus = execFileSync('docker', ['inspect', '--format', '{{.State.Status}} exitCode={{.State.ExitCode}} oom={{.State.OOMKilled}} err={{.State.Error}}', cfg.container], {
        encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch { /* ditto */ }
    logFn?.(`GGUF ${cfg.label} container failed to become healthy. inspect: ${inspectStatus || '(unavailable)'}`);
    if (containerLogs.trim()) logFn?.(`GGUF ${cfg.label} container last logs:\n${containerLogs}`);
    removeContainer(cfg.container);
    throw new Error(
      `GGUF ${cfg.label} container failed to become healthy` +
      (inspectStatus ? ` (state: ${inspectStatus})` : '') +
      (containerLogs.trim() ? `\n--- container logs ---\n${containerLogs.trim()}\n----------------------` : ''),
    );
  }

  activeModel = model;
  logFn?.(`GGUF ${cfg.label} model ready`);
}

// ---------------------------------------------------------------------------
// Public lifecycle API (unchanged signatures for callers)
// ---------------------------------------------------------------------------

/**
 * Validate prerequisites for GGUF containers (model files present, Docker
 * daemon up, zombie containers cleaned) and, when requested, eagerly load
 * an initial model into VRAM.
 *
 * Initial-model strategy:
 *   - `'lazy'` (default): validate prereqs only; do NOT load any model. The
 *     `pre_hook` wired in `sdk-embedding.ts` will spawn the right container
 *     on the first `embedCode()` / `embedNlp()` call. Runs whose cache is
 *     fully warm therefore never load a model and never pay the boot cost.
 *   - `'code'` / `'nlp'`: eagerly load that model so the first embed is
 *     instant. Use this only when the caller knows it will embed.
 *
 * For per-second progress feedback during the VRAM load (initial start *and*
 * subsequent swaps), register a callback via {@link setGgufWaitProgressHandler}
 * before calling this function.
 *
 * @param projectRoot - Project root path (reserved for future per-project config).
 * @param initialModel - Which model to eagerly load. Defaults to `'lazy'` (none).
 * @param onLog - Optional callback for status/error messages during startup.
 * @returns `true` if prerequisites validated (and the eager model, if any, became healthy), `false` on any failure.
 */
export async function startGgufContainers(
  projectRoot: string,
  initialModel: 'code' | 'nlp' | 'lazy' = 'lazy',
  onLog?: (message: string) => void,
): Promise<boolean> {
  modelsDirectory = anatolyPath(projectRoot, 'shared/models/gguf');
  logFn = onLog;

  // Verify model files exist
  const codeModelPath = resolve(modelsDirectory, GGUF_CODE_MODEL_FILE);
  const nlpModelPath = resolve(modelsDirectory, GGUF_NLP_MODEL_FILE);

  if (!existsSync(codeModelPath)) {
    onLog?.(`GGUF code model not found: ${codeModelPath} — run 'anatoly local-embeddings upgrade' first`);
    return false;
  }
  if (!existsSync(nlpModelPath)) {
    onLog?.(`GGUF NLP model not found: ${nlpModelPath} — run 'anatoly local-embeddings upgrade' first`);
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
    const zombies = execSync(
      `docker ps -aq --filter "name=anatoly-gguf"`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    if (zombies) {
      onLog?.('cleaning up leftover GGUF containers...');
      execSync(`docker rm -f ${zombies}`, { stdio: 'ignore', timeout: 10_000 });
    }
  } catch {
    // ignore cleanup errors
  }

  // Lazy mode: prereqs validated, no model loaded. The SDK pre_hook will
  // spawn the right container on the first embed call (if any).
  if (initialModel === 'lazy') return true;

  try {
    await ensureModel(initialModel);
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
