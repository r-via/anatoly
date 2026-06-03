// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Shared Docker container lifecycle helpers, used by both the GGUF
 * (`docker-gguf.ts`) and TEI (`docker-tei.ts`) embedding backends. Extracted
 * to remove the byte-identical copies the two modules carried.
 */

import { execFileSync } from 'node:child_process';

/**
 * Remove a Docker container by name (running or stopped).
 * No-op if the container doesn't exist.
 */
export function removeContainer(name: string): void {
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    // Container doesn't exist — OK
  }
}

/**
 * Wait for a container's `/health` endpoint to respond OK, polling once a
 * second until `timeoutMs` elapses. Each probe is bounded to 2s. Models may
 * need to be downloaded on first run (can take minutes).
 *
 * @returns true if the container became healthy before the timeout.
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
