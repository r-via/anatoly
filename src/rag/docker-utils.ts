// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Shared Docker container helpers used by both GGUF and TEI lifecycle modules.
 */

import { execFileSync, execSync } from 'node:child_process';

/** Check if Docker daemon is running and accessible. */
export function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a Docker container by name (running or stopped).
 * No-op if the container doesn't exist.
 */
export function removeContainer(name: string): void {
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
export async function waitForContainer(
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
