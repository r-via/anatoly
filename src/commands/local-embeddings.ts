// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/**
 * Locate the setup-embeddings.sh script relative to the package root.
 * Works both in dev (src/commands/) and bundle (dist/) layouts.
 */
function findSetupScript(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidate1 = resolve(thisDir, '..', 'scripts', 'setup-embeddings.sh');
  if (existsSync(candidate1)) return candidate1;
  const candidate2 = resolve(thisDir, '..', '..', 'scripts', 'setup-embeddings.sh');
  if (existsSync(candidate2)) return candidate2;
  throw new Error('setup-embeddings.sh not found — is the scripts/ directory present?');
}

function runScript(scriptArgs: string[]): void {
  const script = findSetupScript();
  execFileSync('bash', [script, ...scriptArgs], {
    stdio: 'inherit',
    env: { ...process.env, ANATOLY_PROJECT_ROOT: process.cwd() },
  });
}

/**
 * Registers the `local-embeddings` command group on the given Commander program.
 *
 * Sub-commands:
 *   - `upgrade` — install the advanced GPU/GGUF backend (Docker llama.cpp + model weights)
 *   - `status`  — inspect the current local-embeddings install without making changes
 *
 * The default tier (lite, ONNX in-process) is always available and needs no
 * setup — these commands exist solely to opt into the advanced tier.
 */
export function registerLocalEmbeddingsCommand(program: Command): void {
  const group = program
    .command('local-embeddings')
    .description('Manage the local embedding backend (lite is default; upgrade to advanced GPU/GGUF)');

  group
    .command('upgrade')
    .description('Install the advanced GPU/GGUF backend (Docker llama.cpp + model weights)')
    .action(() => {
      runScript([]);
    });

  group
    .command('status')
    .description('Show the current local-embeddings install status without making changes')
    .action(() => {
      runScript(['--check']);
    });
}
