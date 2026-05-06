// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { parseDocument, isMap, YAMLMap } from 'yaml';
import { detectHardware, readEmbeddingsReadyFlag, GGUF_MIN_VRAM_GB } from '../rag/hardware-detect.js';
import { runLitePrefetch } from '../cli/setup-prompts.js';

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

const LOCAL_LITE_PROVIDER: Record<string, unknown> = {
  transport: 'onnxruntime_node',
  models: ['jinaai/jina-embeddings-v2-base-code', 'Xenova/all-MiniLM-L6-v2'],
};

const LITE_EMBEDDING_ROUTING: Record<string, string> = {
  code: 'local-lite/jinaai/jina-embeddings-v2-base-code',
  text: 'local-lite/Xenova/all-MiniLM-L6-v2',
};

/**
 * Add the `local-advanced` provider and re-point `routing.embeddings` at it.
 * `local-lite` is intentionally left in `providers` so the user can switch
 * back to the in-process tier by editing `routing.embeddings` alone — the
 * providers map is a registry, not an active-state flag. Comments and blank
 * lines elsewhere in the file are preserved by mutating the YAML document in
 * place rather than round-tripping through a plain JS object.
 *
 * Exported for testing; not part of the public API.
 */
export function patchConfigToAdvanced(projectRoot: string): void {
  const path = resolve(projectRoot, '.anatoly.yml');
  const raw = readFileSync(path, 'utf-8');
  const doc = parseDocument(raw);

  let providers = doc.get('providers');
  if (!isMap(providers)) {
    providers = new YAMLMap();
    doc.set('providers', providers);
  }
  (providers as YAMLMap).set('local-advanced', LOCAL_ADVANCED_PROVIDER);

  let routing = doc.get('routing');
  if (!isMap(routing)) {
    routing = new YAMLMap();
    doc.set('routing', routing);
  }
  (routing as YAMLMap).set('embeddings', { ...ADVANCED_EMBEDDING_ROUTING });

  writeFileSync(path, doc.toString({ lineWidth: 120 }), 'utf-8');
}

/**
 * Symmetric counterpart to {@link patchConfigToAdvanced}: re-point
 * `routing.embeddings` at `local-lite`. Self-healing — if the `local-lite`
 * provider entry is missing (e.g. a config produced before lite was a default
 * registry entry), it is re-added from the canonical wizard template. The
 * Docker container and downloaded GGUF weights are left untouched so the user
 * can re-upgrade instantly without re-downloading.
 *
 * Exported for testing; not part of the public API.
 */
export function patchConfigToLite(projectRoot: string): void {
  const path = resolve(projectRoot, '.anatoly.yml');
  const raw = readFileSync(path, 'utf-8');
  const doc = parseDocument(raw);

  let providers = doc.get('providers');
  if (!isMap(providers)) {
    providers = new YAMLMap();
    doc.set('providers', providers);
  }
  if (!(providers as YAMLMap).has('local-lite')) {
    (providers as YAMLMap).set('local-lite', LOCAL_LITE_PROVIDER);
  }

  let routing = doc.get('routing');
  if (!isMap(routing)) {
    routing = new YAMLMap();
    doc.set('routing', routing);
  }
  (routing as YAMLMap).set('embeddings', { ...LITE_EMBEDDING_ROUTING });

  writeFileSync(path, doc.toString({ lineWidth: 120 }), 'utf-8');
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
      'This upgrade will update `.anatoly.yml`: a `local-advanced` provider '
      + 'will be added and `routing.embeddings` re-pointed at the GGUF '
      + 'backend. `local-lite` is kept so you can switch back by editing '
      + 'routing alone. Comments and formatting are preserved. Continue?',
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
 *   - `upgrade`   — install the advanced GPU/GGUF backend (Docker llama.cpp + model weights)
 *   - `downgrade` — re-point routing.embeddings back to lite (config-only, no teardown)
 *   - `init`      — re-run the embedding tier picker on an existing project
 *   - `cleanup`   — remove the advanced backend (containers, image, GGUF weights)
 *   - `status`    — inspect the current local-embeddings install without making changes
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
    .command('cleanup')
    .description('Remove the advanced backend: stop containers, delete Docker image and GGUF weights')
    .action(async () => {
      const projectRoot = process.cwd();
      const configPath = resolve(projectRoot, '.anatoly.yml');

      if (!process.stdin.isTTY) {
        p.note(
          'Cleanup is destructive (removes Docker image and ~15 GB of GGUF '
          + 'weights). Re-run from an interactive shell.',
          'local-embeddings cleanup aborted',
        );
        process.exit(1);
      }

      const ok = await p.confirm({
        message:
          'Remove the advanced backend? This stops anatoly-* containers, '
          + 'deletes the llama.cpp Docker image, and erases ~15 GB of GGUF '
          + 'weights from `~/.anatoly/models/`. The lite (ONNX) backend is '
          + 'unaffected.',
        initialValue: false,
      });
      if (p.isCancel(ok) || ok !== true) {
        p.cancel('Aborted.');
        process.exit(1);
      }

      // Auto-downgrade routing if it still points at local-advanced — leaving
      // it in place would yield a broken config the moment containers are gone.
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, 'utf-8');
        if (raw.includes('local-advanced/')) {
          patchConfigToLite(projectRoot);
          p.note(
            '`routing.embeddings` was pointing at `local-advanced` — '
            + 're-pointed at `local-lite` before cleanup.',
            'Config updated',
          );
        }
      }

      const result = runScript(['--cleanup']);
      if (!result.ok) process.exit(result.exitCode || 1);
    });

  group
    .command('init')
    .description('Re-run the embedding tier picker on an existing project (lite or advanced)')
    .action(async () => {
      const projectRoot = process.cwd();
      const configPath = resolve(projectRoot, '.anatoly.yml');
      if (!existsSync(configPath)) {
        p.note(
          'No `.anatoly.yml` found in the current directory. Run `anatoly run` '
          + 'first to create one — `init` only re-plays the embedding tier '
          + 'picker on an existing project.',
          'Nothing to initialize',
        );
        process.exit(1);
      }

      if (!process.stdin.isTTY) {
        p.note('Tier picker requires an interactive shell.', 'local-embeddings init aborted');
        process.exit(1);
      }

      const hw = detectHardware();
      const advancedAvailable = hw.hasGpu && hw.gpuType === 'cuda' && (hw.vramGB ?? 0) >= GGUF_MIN_VRAM_GB;

      type TierValue = 'lite' | 'advanced';
      const options: Array<{ value: TierValue; label: string; hint?: string }> = [
        { value: 'lite', label: 'Lite — ONNX CPU, works everywhere', hint: '~150 MB, instant' },
      ];
      if (advancedAvailable) {
        options.push({
          value: 'advanced',
          label: 'Advanced — GGUF GPU, higher recall',
          hint: '~15 GB, 2–5 min setup',
        });
      }

      const tier = await p.select({ message: 'Which embedding backend?', options });
      if (p.isCancel(tier)) {
        p.cancel('Aborted.');
        process.exit(0);
      }

      if (tier === 'lite') {
        patchConfigToLite(projectRoot);
        await runLitePrefetch({ isTTY: true, defaultsSettings: false });
        p.note('`.anatoly.yml` now uses `local-lite`.', 'Config updated');
        return;
      }

      // Advanced: same flow as `upgrade` minus the existing-config confirm
      // prompt (the user explicitly chose advanced from the picker).
      const upgradeResult = runScript([]);
      if (!upgradeResult.ok) process.exit(upgradeResult.exitCode || 1);
      const checkResult = runScript(['--check']);
      if (!checkResult.ok) process.exit(checkResult.exitCode || 1);

      const flag = readEmbeddingsReadyFlag(projectRoot);
      if (flag?.backend !== 'advanced-gguf') {
        p.note(
          `Expected backend 'advanced-gguf' in embeddings-ready.json but got `
          + `'${flag?.backend ?? 'none'}'. Config was not patched.`,
          'Validation failed',
        );
        process.exit(1);
      }
      patchConfigToAdvanced(projectRoot);
      p.note('`.anatoly.yml` now uses `local-advanced`.', 'Config updated');
    });

  group
    .command('downgrade')
    .description('Re-point routing.embeddings back to the lite (ONNX) backend — leaves Docker/GGUF in place')
    .action(() => {
      const projectRoot = process.cwd();
      const configPath = resolve(projectRoot, '.anatoly.yml');
      if (!existsSync(configPath)) {
        p.note(
          'No `.anatoly.yml` found in the current directory. Run the first-run '
          + 'wizard (`anatoly run`) to create one.',
          'Nothing to downgrade',
        );
        process.exit(1);
      }
      patchConfigToLite(projectRoot);
      p.note(
        '`routing.embeddings` now points at `local-lite`. The advanced '
        + 'Docker container and GGUF weights were left in place — re-run '
        + '`anatoly local-embeddings upgrade` to switch back without '
        + 're-downloading.',
        'Downgraded to lite',
      );
    });

  group
    .command('status')
    .description('Show the current local-embeddings install status without making changes')
    .action(() => {
      const result = runScript(['--check']);
      if (!result.ok) process.exit(result.exitCode || 1);
    });
}
