// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Check if a process with the given PID is still running.
 *
 * Uses `process.kill(pid, 0)` as a liveness probe (no signal is delivered).
 * Returns `true` for EPERM errors because permission-denied means the process
 * exists but is owned by another user.
 *
 * @param pid - OS process ID to check. Values <= 0, NaN, or falsy return `false`.
 * @returns `true` if the process exists (even if not owned by the current user).
 */
export function isProcessRunning(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') return true;
    return false;
  }
}
