import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getSidecarUrl, getSidecarPort, detectSidecar } from './hardware-detect.js';

let sidecarProcess: ChildProcess | null = null;
let managedByUs = false;

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
  // Already running (externally or by us)?
  const status = await detectSidecar();
  if (status.running) return true;

  // Spawn the sidecar — script lives at <project>/scripts/embed-server.py
  const scriptPath = resolve(process.cwd(), 'scripts', 'embed-server.py');
  if (!existsSync(scriptPath)) {
    onLog?.(`embed-server.py not found at ${scriptPath}`);
    return false;
  }
  const port = getSidecarPort();
  const python = findPython(process.cwd());
  onLog?.(`starting embed sidecar on port ${port} (python: ${python})...`);

  try {
    sidecarProcess = spawn(python, [scriptPath, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    managedByUs = true;

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
 * Stop the sidecar if we started it. No-op if it was running externally.
 */
export async function stopSidecar(): Promise<void> {
  if (!managedByUs || !sidecarProcess) return;

  try {
    // Graceful shutdown via HTTP
    await fetch(`${getSidecarUrl()}/shutdown`, { method: 'POST' }).catch(() => {});
  } catch {
    // Ignore
  }

  // Give it a moment, then force kill if still alive
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (sidecarProcess && !sidecarProcess.killed) {
        sidecarProcess.kill('SIGKILL');
      }
      resolve();
    }, 3000);

    if (sidecarProcess) {
      sidecarProcess.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    } else {
      clearTimeout(timeout);
      resolve();
    }
  });

  sidecarProcess = null;
  managedByUs = false;
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
