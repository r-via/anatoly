// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import yaml from 'js-yaml';
import { readEmbeddingsReadyFlag } from '../rag/hardware-detect.js';

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

function runScript(scriptArgs: string[]): { ok: boolean; exitCode: number } {
  const script = findSetupScript();
  const result = spawnSync('bash', [script, ...scriptArgs], {
    stdio: 'inherit',
    env: { ...process.env, ANATOLY_PROJECT_ROOT: process.cwd() },
  });
  return { ok: result.status === 0, exitCode: result.status ?? -1 };
}

/**
 * Canonical `local-advanced` provider declaration written into `providers`
 * after a successful upgrade. Mirrors the wizard's first-run template
 * (LOCAL_ADVANCED_PROVIDER in setup-prompts.ts) so a config produced by the
 * wizard and one produced by post-upgrade patching are byte-equivalent.
 */
const LOCAL_ADVANCED_PROVIDER: Record<string, unknown> = {
  transport: 'openai_compatible',
  auth: 'api_key',
  env_key: 'ANATOLY_LOCAL_DUMMY_KEY',
  base_url: 'http://localhost:8082/v1',
  models: ['nomic-embed-code-gguf', 'qwen3-embedding-8b-gguf'],
};

const ADVANCED_EMBEDDING_ROUTING: Record<string, string> = {
  code: 'local-advanced/nomic-embed-code-gguf',
  text: 'local-advanced/qwen3-embedding-8b-gguf',
};

/**
 * Rewrite the `providers` and `routing.embeddings` sections of `.anatoly.yml`
 * to point at `local-advanced`. Comments in the original file are dropped —
 * the user has been warned beforehand.
 *
 * Exported for testing; not part of the public API.
 */
export function patchConfigToAdvanced(projectRoot: string): void {
  const path = resolve(projectRoot, '.anatoly.yml');
  const raw = readFileSync(path, 'utf-8');
  const doc = (yaml.load(raw) ?? {}) as Record<string, unknown>;

  const providers = (doc.providers ?? {}) as Record<string, unknown>;
  providers['local-advanced'] = LOCAL_ADVANCED_PROVIDER;
  doc.providers = providers;

  const routing = (doc.routing ?? {}) as Record<string, unknown>;
  routing.embeddings = { ...ADVANCED_EMBEDDING_ROUTING };
  doc.routing = routing;

  writeFileSync(path, yaml.dump(doc, { lineWidth: 120, noRefs: true }), 'utf-8');
}

/**
 * Prompt the user to confirm the destructive config rewrite. Returns `true`
 * to proceed, `false` to abort. Non-interactive shells auto-decline so a
 * script never silently nukes a hand-tuned config.
 */
async function confirmOverwrite(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    p.note(
      'A `.anatoly.yml` already exists, but stdin is not a TTY so the '
      + 'overwrite confirmation cannot be shown. Re-run from an '
      + 'interactive shell, or remove `.anatoly.yml` first.',
      'local-embeddings upgrade aborted',
    );
    return false;
  }

  const answer = await p.confirm({
    message:
      'This upgrade will overwrite the embedding section of `.anatoly.yml` '
      + '(providers + routing.embeddings). If you have configured an external '
      + 'tier (Mistral/OpenRouter/...) it will be replaced. Continue?',
    initialValue: false,
  });

  if (p.isCancel(answer)) {
    p.cancel('Aborted.');
    return false;
  }
  return answer === true;
}

/**
 * `upgrade` action: pre-flight prompt → script → status check → config patch.
 *
 * Flow:
 *   1. If `.anatoly.yml` exists, ask the user to confirm the rewrite.
 *   2. Run the install script (Docker pull, GGUF download, sample probes).
 *   3. Run `--check` to revalidate the install end-to-end.
 *   4. If both succeed AND `.anatoly.yml` existed at step 1 (and the user
 *      confirmed), patch providers + routing.embeddings to `local-advanced`.
 *
 * If `.anatoly.yml` does not exist, we skip the prompt and the patch — the
 * next first-run wizard will pick up `embeddings-ready.json` and emit a
 * fully-formed advanced config.
 */
async function runUpgrade(): Promise<void> {
  const projectRoot = process.cwd();
  const configPath = resolve(projectRoot, '.anatoly.yml');
  const configExisted = existsSync(configPath);

  if (configExisted) {
    const ok = await confirmOverwrite();
    if (!ok) {
      process.exit(1);
    }
  }

  const upgradeResult = runScript([]);
  if (!upgradeResult.ok) {
    process.exit(upgradeResult.exitCode || 1);
  }

  const checkResult = runScript(['--check']);
  if (!checkResult.ok) {
    p.note(
      'Upgrade completed but post-install `--check` failed. Config was not '
      + 'patched — re-run `anatoly local-embeddings status` to inspect.',
      'Validation failed',
    );
    process.exit(checkResult.exitCode || 1);
  }

  const flag = readEmbeddingsReadyFlag(projectRoot);
  if (flag?.backend !== 'advanced-gguf') {
    p.note(
      `Expected backend 'advanced-gguf' in embeddings-ready.json but got `
      + `'${flag?.backend ?? 'none'}'. Config was not patched.`,
      'Validation failed',
    );
    process.exit(1);
  }

  if (configExisted) {
    patchConfigToAdvanced(projectRoot);
    p.note(
      '`.anatoly.yml` updated: providers.local-advanced + '
      + 'routing.embeddings now point at the GGUF backend.',
      'Config updated',
    );
  }
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
    .action(async () => {
      await runUpgrade();
    });

  group
    .command('status')
    .description('Show the current local-embeddings install status without making changes')
    .action(() => {
      const result = runScript(['--check']);
      if (!result.ok) process.exit(result.exitCode || 1);
    });
}
