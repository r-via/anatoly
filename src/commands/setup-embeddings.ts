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
  // Bundle: dist/ → root
  const candidate1 = resolve(thisDir, '..', 'scripts', 'setup-embeddings.sh');
  if (existsSync(candidate1)) return candidate1;
  // Dev: src/commands/ → src/ → root
  const candidate2 = resolve(thisDir, '..', '..', 'scripts', 'setup-embeddings.sh');
  if (existsSync(candidate2)) return candidate2;
  throw new Error('setup-embeddings.sh not found — is the scripts/ directory present?');
}

export function registerSetupEmbeddingsCommand(program: Command): void {
  program
    .command('setup-embeddings')
    .description('Install embedding backends (lite/fp16/gguf) for GPU-accelerated embeddings')
    .option('--check', 'check current embedding setup status without installing')
    .option('--ab-test', 'run A/B test comparing bf16 vs GGUF embedding quality')
    .action((opts: { check?: boolean; abTest?: boolean }) => {
      const script = findSetupScript();
      const args: string[] = [];
      if (opts.abTest) args.push('--ab-test');
      else if (opts.check) args.push('--check');
      execFileSync('bash', [script, ...args], { stdio: 'inherit' });
    });
}
