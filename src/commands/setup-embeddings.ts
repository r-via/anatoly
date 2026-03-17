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
    .description('Install sentence-transformers + nomic-embed-code for GPU-accelerated embeddings')
    .option('--check', 'check current embedding setup status without installing')
    .action((opts: { check?: boolean }) => {
      const script = findSetupScript();
      const args = opts.check ? ['--check'] : [];
      execFileSync('bash', [script, ...args], { stdio: 'inherit' });
    });
}
