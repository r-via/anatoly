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

import { recoverCwdIfBroken } from './boot-cwd.js';

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

await import('./main.js');
