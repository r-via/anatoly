// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { getSidecarUrl, getSidecarPort, detectSidecar } from './hardware-detect.js';
import { isProcessRunning } from '../utils/process.js';

let sidecarProcess: ChildProcess | null = null;
let managedByUs = false;

/**
 * Root of the anatoly package.
 * - Bundle (dist/index.js):      dirname = dist/  → one level up
 * - Dev    (src/rag/embed-sidecar.ts): dirname = src/rag/ → two levels up
 * We detect which case by checking for scripts/ at each candidate.
 */
function findPkgRoot(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // Try one level up first (bundle layout: dist/ → root)
  const candidate1 = resolve(thisDir, '..');
  if (existsSync(resolve(candidate1, 'scripts', 'embed-server.py'))) return candidate1;
  // Two levels up (dev layout: src/rag/ → src/ → root)
  const candidate2 = resolve(thisDir, '..', '..');
  if (existsSync(resolve(candidate2, 'scripts', 'embed-server.py'))) return candidate2;
  // Fallback to cwd (running from project root)
  return process.cwd();
}
const PKG_ROOT = findPkgRoot();

// ---------------------------------------------------------------------------
// PID file helpers (mirrors lock.ts pattern)
// ---------------------------------------------------------------------------

function getSidecarPidPath(): string {
  return resolve(process.cwd(), '.anatoly', 'sidecar.pid');
}

function writeSidecarPid(pid: number): void {
  const pidPath = getSidecarPidPath();
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, JSON.stringify({ pid, started_at: new Date().toISOString() }, null, 2) + '\n');
}

function removeSidecarPid(): void {
  try { unlinkSync(getSidecarPidPath()); } catch { /* already gone */ }
}

/**
 * Kill a process by PID: SIGTERM, wait up to 2s, then SIGKILL if needed.
 */
async function killProcess(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isProcessRunning(pid)) return;
  }

  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

/**
 * Find embed-server.py processes belonging to this project via pgrep.
 * Matches on .anatoly in the command line (venv python path) — any
 * embed-server launched through anatoly's own venv is ours, not external.
 */
function findProjectSidecars(): number[] {
  try {
    const output = execSync('pgrep -af embed-server\\.py', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return output.trim().split('\n')
      .filter(line => line.includes('.anatoly'))
      .map(line => parseInt(line, 10))
      .filter(pid => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

/**
 * Kill any orphaned sidecar from a previous run.
 * Two strategies:
 * 1. PID file (.anatoly/sidecar.pid) — fast, covers normal orphans
 * 2. pgrep filtered by this project's script path — catches strays
 *    with no PID file (old code, crash before PID write, etc.)
 *
 * Only kills processes whose command line contains this project's
 * embed-server.py path — never touches unrelated sidecars.
 */
async function cleanStaleSidecar(onLog?: (message: string) => void): Promise<void> {
  const killed: number[] = [];

  // 1. PID file check
  const pidPath = getSidecarPidPath();
  if (existsSync(pidPath)) {
    let pid: number | undefined;
    try {
      const data = JSON.parse(readFileSync(pidPath, 'utf-8')) as { pid: number };
      if (data.pid && typeof data.pid === 'number' && data.pid > 0) pid = data.pid;
    } catch { /* corrupted */ }

    if (pid && isProcessRunning(pid)) {
      await killProcess(pid);
      killed.push(pid);
    }
    removeSidecarPid();
  }

  // 2. pgrep fallback — scoped to this project's script path
  const strays = findProjectSidecars().filter(pid => !killed.includes(pid));
  for (const pid of strays) {
    await killProcess(pid);
    killed.push(pid);
  }

  if (killed.length > 0) {
    const msg = `Stale embed-server.py killed (PID ${killed.join(', ')})`;
    console.log(`  ${msg}`);
    onLog?.(msg);
  }
}

/**
 * Find the best python binary: active venv > .venv/ > system python3.
 */
function findPython(projectRoot: string): string {
  // Active venv (user ran `source .venv/bin/activate`)
  if (process.env.VIRTUAL_ENV) {
    const venvPy = resolve(process.env.VIRTUAL_ENV, 'bin', 'python');
    if (existsSync(venvPy)) return venvPy;
  }

  // Anatoly's dedicated venv (created by setup-embeddings.sh)
  const dotVenvPy = resolve(projectRoot, '.anatoly', '.venv', 'bin', 'python');
  if (existsSync(dotVenvPy)) return dotVenvPy;

  // Fallback to system python
  return 'python3';
}

/**
 * Ensure the embed sidecar is running. If it's already running externally,
 * does nothing. Otherwise spawns it as a detached child process and waits
 * for it to become ready (up to 60s for model loading).
 *
 * Returns true if the sidecar is available, false if it couldn't start.
 */
export async function ensureSidecar(
  onLog?: (message: string) => void,
  onProgress?: (elapsed: number) => void,
): Promise<boolean> {
  // Kill any orphaned sidecar from a previous crashed run
  await cleanStaleSidecar(onLog);

  // Already running? After cleanStaleSidecar, any survivor is truly external.
  const status = await detectSidecar();
  if (status.running) {
    onLog?.(`sidecar already running — ${status.model ?? 'unknown'} (${status.dim ?? '?'}d) on ${status.device ?? '?'}`);
    return true;
  }

  // Spawn the sidecar — script ships with the anatoly package
  const scriptPath = resolve(PKG_ROOT, 'scripts', 'embed-server.py');
  if (!existsSync(scriptPath)) {
    onLog?.(`embed-server.py not found at ${scriptPath}`);
    return false;
  }
  const port = getSidecarPort();
  const python = findPython(process.cwd());
  onLog?.(`starting embed sidecar on port ${port} (python: ${python})...`);

  try {
    const idleTimeout = process.env.ANATOLY_EMBED_IDLE_TIMEOUT ?? '60';
    sidecarProcess = spawn(python, [scriptPath, '--port', String(port), '--idle-timeout', idleTimeout], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    managedByUs = true;
    if (sidecarProcess.pid) writeSidecarPid(sidecarProcess.pid);

    // Forward stderr for debugging
    sidecarProcess.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) onLog?.(`[embed-server] ${msg}`);
    });

    // Wait for the sidecar to become ready (7B model can take 30-120s)
    const ready = await waitForReady(180_000, onProgress);
    if (ready) {
      const info = await detectSidecar();
      onLog?.(`embed sidecar ready: ${info.model} on ${info.device} (${info.dim}d)`);
      return true;
    }

    onLog?.('embed sidecar failed to start within 180s — falling back to ONNX');
    stopSidecar();
    return false;
  } catch (err) {
    onLog?.(`embed sidecar spawn failed: ${(err as Error).message} — falling back to ONNX`);
    return false;
  }
}

/**
 * Stop the sidecar. Handles two cases:
 * - We spawned it (sidecarProcess set): HTTP shutdown + SIGKILL fallback
 * - We adopted it (detected running, no handle): HTTP shutdown only
 */
export async function stopSidecar(): Promise<void> {
  // Stop both managed and adopted sidecars to free RAM for subsequent phases
  const wasManaged = managedByUs;

  // Always attempt HTTP shutdown — works for both managed and adopted sidecars
  try {
    await fetch(`${getSidecarUrl()}/shutdown`, { method: 'POST' }).catch(() => {});
  } catch {
    // Ignore — server may already be gone
  }

  if (sidecarProcess) {
    // We have a process handle — wait for exit or force kill (2s timeout)
    await new Promise<void>((resolve) => {
      const proc = sidecarProcess!;
      const onExit = () => { clearTimeout(killTimer); resolve(); };
      proc.once('exit', onExit);

      const killTimer = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
          const reapTimer = setTimeout(() => resolve(), 1000);
          proc.once('exit', () => { clearTimeout(reapTimer); resolve(); });
        } else {
          resolve();
        }
      }, 2000);
    });
  } else if (wasManaged) {
    // Adopted sidecar (no handle) — give HTTP shutdown time to take effect
    await new Promise(r => setTimeout(r, 1000));
  } else {
    // Not managed by us — kill any project sidecars found via pgrep
    const pids = findProjectSidecars();
    for (const pid of pids) {
      await killProcess(pid);
    }
  }

  sidecarProcess = null;
  managedByUs = false;
  removeSidecarPid();
}

/**
 * Swap the sidecar's loaded model at runtime via the /load endpoint.
 * Frees GPU memory from the current model and loads the new one.
 * Returns true if the swap succeeded, false on error.
 */
export async function swapSidecarModel(
  newModel: string,
  onLog?: (message: string) => void,
  quantize?: boolean,
): Promise<boolean> {
  const url = getSidecarUrl();
  const prec = quantize ? 'int8' : 'bf16';
  onLog?.(`swapping sidecar model to ${newModel} (${prec})...`);

  try {
    const controller = new AbortController();
    // Model loading can take 30-120s for large models
    const timeout = setTimeout(() => controller.abort(), 180_000);
    const res = await fetch(`${url}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: newModel, quantize: quantize ?? false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text();
      onLog?.(`sidecar model swap failed (${res.status}): ${body}`);
      return false;
    }

    const data = await res.json() as { status: string; model: string; dim: number; quantized?: boolean };
    onLog?.(`sidecar model swapped: ${data.model} (${data.dim}d, ${data.quantized ? 'int8' : 'bf16'})`);
    return true;
  } catch (err) {
    onLog?.(`sidecar model swap error: ${(err as Error).message}`);
    return false;
  }
}

async function waitForReady(
  timeoutMs: number,
  onProgress?: (elapsedSec: number) => void,
): Promise<boolean> {
  const start = Date.now();
  const url = `${getSidecarUrl()}/health`;

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
