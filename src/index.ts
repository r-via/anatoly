// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

// Bootstrap layer: runs before the main bundle so cwd is recoverable
// before any transitive import (notably @anthropic-ai/claude-agent-sdk)
// evaluates `process.cwd()` at module-load time.
//
// ESM hoists static imports — putting recovery inside src/main.ts would
// still load the SDK first. The dynamic import below defers main.ts
// evaluation until after recoverCwdIfBroken has run.

import { isCwdHome, isInsideAnatolyDir, recoverCwdIfBroken } from './boot-cwd.js';

const recovery = recoverCwdIfBroken();
if (
  recovery.wasBroken &&
  recovery.recoveredTo &&
  process.argv.includes('--verbose')
) {
  process.stderr.write(
    `anatoly: working directory was deleted; recovered to ${recovery.recoveredTo}\n`,
  );
}

// Refuse to run from inside a `.anatoly/` working directory. That folder
// holds Anatoly's per-project state (runs, cache, embeddings, RAG index);
// it is never the codebase the user wants to audit. Treating it as one
// would mangle paths, pollute caches, and overwrite live state.
{
  let cwd: string | null = null;
  try { cwd = process.cwd(); } catch { /* recovery failed — let main.ts surface it */ }
  if (cwd && isInsideAnatolyDir(cwd)) {
    process.stderr.write(
      [
        '',
        'anatoly: refusing to run from inside a `.anatoly/` working directory.',
        `  cwd: ${cwd}`,
        '',
        '`.anatoly/` is Anatoly\'s own state folder, not a codebase to audit.',
        'cd to your project root and try again.',
        '',
      ].join('\n') + '\n',
    );
    process.exit(1);
  }

  // Also refuse `cwd == $HOME`: ~/.anatoly/ is the user-wide root (only meant
  // to host `shared/` and `user/`); running here would scatter project-local
  // state (cache/, runs/, state/, setup/, runtime/) into it and break the
  // separation between user-wide and project-local trees.
  if (cwd && isCwdHome(cwd, process.env.HOME)) {
    process.stderr.write(
      [
        '',
        'anatoly: refusing to run from your HOME directory.',
        `  cwd: ${cwd}`,
        '',
        '~/.anatoly/ is the user-wide root for shared/ and user/ symlink targets.',
        'Running here would scatter per-project state (cache/, runs/, state/, …)',
        'into the user-wide tree. cd into the actual project and try again.',
        '',
      ].join('\n') + '\n',
    );
    process.exit(1);
  }
}

await import('./main.js');
