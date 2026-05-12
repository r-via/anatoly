// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

// Runs BEFORE every other import in src/index.ts.
//
// Why: when the user's shell sits in a directory whose inode has been
// removed (typical when a prior anatoly run wiped and recreated
// .anatoly/state/internal-docs/ underneath them), `process.cwd()` throws
// ENOENT on uv_cwd. The Claude Agent SDK calls `process.cwd()` at module
// load — so anatoly crashes at import time before any of our error
// handling can run. Recovery here chdir's to the first existing ancestor
// of $PWD (or $HOME / /tmp / / as fallbacks) so the rest of the boot
// proceeds normally.
//
// Keep this file dependency-free apart from node:fs and node:path so it
// can run before anything that might itself touch the cwd.

import { statSync } from 'node:fs';
import { dirname } from 'node:path';

export function firstExistingAncestor(start: string): string | null {
  if (!start.startsWith('/')) return null;
  let dir = start;
  while (true) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      /* missing — keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function pickRecoveryCandidates(env: NodeJS.ProcessEnv): string[] {
  return [env.PWD, env.HOME, '/tmp', '/'].filter(
    (p): p is string => typeof p === 'string' && p.startsWith('/'),
  );
}

export interface RecoveryResult {
  wasBroken: boolean;
  recoveredTo: string | null;
}

export function recoverCwdIfBroken(deps?: {
  cwdGetter?: () => string;
  chdirFn?: (p: string) => void;
  env?: NodeJS.ProcessEnv;
}): RecoveryResult {
  const cwdGetter = deps?.cwdGetter ?? (() => process.cwd());
  const chdirFn = deps?.chdirFn ?? ((p) => process.chdir(p));
  const env = deps?.env ?? process.env;

  try {
    cwdGetter();
    return { wasBroken: false, recoveredTo: null };
  } catch {
    /* cwd is gone — fall through to recovery */
  }

  for (const cand of pickRecoveryCandidates(env)) {
    const target = firstExistingAncestor(cand);
    if (!target) continue;
    try {
      chdirFn(target);
      return { wasBroken: true, recoveredTo: target };
    } catch {
      /* try next candidate */
    }
  }
  return { wasBroken: true, recoveredTo: null };
}

