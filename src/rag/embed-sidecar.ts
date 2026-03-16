import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { getSidecarUrl, getSidecarPort, detectSidecar } from './hardware-detect.js';
import { isProcessRunning } from '../utils/process.js';

let sidecarProcess: ChildProcess | null = null;
let managedByUs = false;

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
 * Find orphaned embed-server.py processes via pgrep (no PID file needed).
 * Returns PIDs of matching processes, excluding our own PID.
 */
function findOrphanedSidecars(): number[] {
  try {
    const output = execSync('pgrep -f embed-server\\.py', { encoding: 'utf-8', timeout: 3000 });
    return output.trim().split('\n')
      .map(s => parseInt(s, 10))
      .filter(pid => pid > 0 && pid !== process.pid);
  } catch {
    // pgrep returns exit code 1 when no match, or not available on this platform
    return [];
  }
}

/**
 * Kill any orphaned sidecar from a previous crashed run.
 * Strategy: PID file first, then pgrep fallback to catch strays.
 */
async function cleanStaleSidecar(onLog?: (message: string) => void): Promise<void> {
  const killed: number[] = [];

  // 1. PID file check (fast, reliable)
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

  // 2. pgrep fallback — catch orphans with no PID file
  const orphans = findOrphanedSidecars().filter(pid => !killed.includes(pid));
  for (const pid of orphans) {
    await killProcess(pid);
    killed.push(pid);
  }

  if (killed.length > 0) {
    onLog?.(`Stale embed-server.py killed (PID ${killed.join(', ')})`);
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

  // Wait for graceful exit (model unload + CUDA cache flush can take a few seconds)
  await new Promise<void>((resolve) => {
    if (!sidecarProcess) { resolve(); return; }

    const proc = sidecarProcess;
    const onExit = () => { clearTimeout(killTimer); resolve(); };
    proc.once('exit', onExit);

    // Allow 8s for graceful shutdown (model unload + torch.cuda.empty_cache)
    const killTimer = setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
        // Wait for the SIGKILL to actually reap the process
        const reapTimer = setTimeout(() => resolve(), 2000);
        proc.once('exit', () => { clearTimeout(reapTimer); resolve(); });
      } else {
        resolve();
      }
    }, 8000);
  });

  sidecarProcess = null;
  managedByUs = false;
  removeSidecarPid();
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
