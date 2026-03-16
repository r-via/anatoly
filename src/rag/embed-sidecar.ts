import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getSidecarUrl, getSidecarPort, detectSidecar } from './hardware-detect.js';

let sidecarProcess: ChildProcess | null = null;
let managedByUs = false;

/**
 * Ensure the embed sidecar is running. If it's already running externally,
 * does nothing. Otherwise spawns it as a detached child process and waits
 * for it to become ready (up to 60s for model loading).
 *
 * Returns true if the sidecar is available, false if it couldn't start.
 */
export async function ensureSidecar(
  onLog?: (message: string) => void,
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
  onLog?.(`starting embed sidecar on port ${port}...`);

  try {
    sidecarProcess = spawn('python3', [scriptPath, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    managedByUs = true;

    // Forward stderr for debugging
    sidecarProcess.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) onLog?.(`[embed-server] ${msg}`);
    });

    // Wait for the sidecar to become ready (model loading can take time)
    const ready = await waitForReady(60_000);
    if (ready) {
      const info = await detectSidecar();
      onLog?.(`embed sidecar ready: ${info.model} on ${info.device} (${info.dim}d)`);
      return true;
    }

    onLog?.('embed sidecar failed to start within 60s — falling back to ONNX');
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

async function waitForReady(timeoutMs: number): Promise<boolean> {
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
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
