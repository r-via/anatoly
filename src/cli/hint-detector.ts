// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import * as p from '@clack/prompts';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GGUF_MIN_VRAM_GB, type HardwareProfile } from '../rag/hardware-detect.js';

const DISMISS_FILE = join('.anatoly', 'hints-dismissed.json');

/** Command attached to a hint that the user can launch directly from the prompt. */
export interface HintCommand {
  /** Label shown in the choice list (e.g. "Run anatoly init"). */
  label: string;
  /** CLI argv after the binary (e.g. ['init']). */
  argv: string[];
}

/** A single actionable hint surfaced before the pipeline summary. */
export interface Hint {
  /** Stable id used to persist dismissal state across runs. */
  id: string;
  /** Short headline shown above the body. */
  title: string;
  /** Multi-line body explaining the situation and the recommendation. */
  body: string;
  /** Optional CLI command the user can launch from the hint prompt. */
  command?: HintCommand;
}

/** Inputs needed to evaluate which hints apply to the current run. */
export interface HintContext {
  projectRoot: string;
  ragEnabled: boolean;
  resolvedRagMode?: 'lite' | 'advanced';
  hardware?: HardwareProfile;
  /** Whether `notifications.telegram.enabled` is true in the loaded config. */
  telegramEnabled: boolean;
}

interface DismissalFile {
  dismissed?: string[];
}

function dismissalsPath(projectRoot: string): string {
  return join(projectRoot, DISMISS_FILE);
}

export function loadDismissedHints(projectRoot: string): Set<string> {
  const path = dismissalsPath(projectRoot);
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as DismissalFile;
    return new Set(parsed.dismissed ?? []);
  } catch {
    return new Set();
  }
}

export function saveDismissedHint(projectRoot: string, hintId: string): void {
  const path = dismissalsPath(projectRoot);
  const set = loadDismissedHints(projectRoot);
  set.add(hintId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ dismissed: [...set] }, null, 2));
}

/**
 * Build the list of hints applicable to the current context.
 * Pure: only reads the project root state passed in via {@link HintContext}.
 */
export function detectHints(ctx: HintContext): Hint[] {
  const hints: Hint[] = [];

  // no-init hint removed — the first-run wizard (Story 48.1+) writes
  // .anatoly.yml automatically, so a missing config is handled at startup.

  const hw = ctx.hardware;
  if (
    ctx.ragEnabled &&
    ctx.resolvedRagMode === 'lite' &&
    hw?.hasGpu &&
    hw.gpuType === 'cuda' &&
    (hw.vramGB ?? 0) >= GGUF_MIN_VRAM_GB
  ) {
    hints.push({
      id: 'lite-rag-can-upgrade',
      title: 'Lite RAG active — your hardware can run the advanced backend',
      body:
        `Detected an NVIDIA GPU with ${hw.vramGB}GB VRAM (>= ${GGUF_MIN_VRAM_GB}GB required).\n` +
        'You can switch to the advanced GGUF embedding backend (nomic-embed-code + Qwen3-8B) for higher recall.\n' +
        'Disk usage: ~10 GB for the GGUF models + ~5 GB for the llama.cpp CUDA Docker image (~15 GB total).\n' +
        '`anatoly setup-embeddings` walks you through installing Docker / the NVIDIA toolkit if needed,\n' +
        'downloads the GGUF models, and starts the containers.',
      command: { label: 'Run anatoly setup-embeddings', argv: ['setup-embeddings'] },
    });
  }

  if (!ctx.telegramEnabled) {
    hints.push({
      id: 'no-telegram-bot',
      title: 'Telegram notifications not configured',
      body:
        "You won't get a ping when an audit finishes — useful for long runs.\n" +
        '`anatoly notifications create-bot` walks you through creating a Telegram bot via @BotFather,\n' +
        'saves the token to .env, and writes the username into .anatoly.yml.',
      command: { label: 'Run anatoly notifications create-bot', argv: ['notifications', 'create-bot'] },
    });
  }

  return hints;
}

function isCancelled(value: unknown): value is symbol {
  return p.isCancel(value);
}

/**
 * Show each non-dismissed hint and act on the user's choice.
 *
 * For each hint the user picks one of:
 *   - run the suggested command (spawns the CLI and exits the current run)
 *   - discard and continue (saves the dismissal so it won't fire again)
 *   - quit (aborts the current run)
 */
export async function runHints(ctx: HintContext): Promise<void> {
  const dismissed = loadDismissedHints(ctx.projectRoot);
  const pending = detectHints(ctx).filter((h) => !dismissed.has(h.id));
  if (pending.length === 0) return;

  for (const hint of pending) {
    p.note(hint.body, chalk.yellow(`hint: ${hint.title}`));

    const options: { value: 'run' | 'discard' | 'quit'; label: string; hint?: string }[] = [];
    if (hint.command) {
      options.push({ value: 'run', label: hint.command.label });
    }
    options.push({ value: 'discard', label: 'Discard and continue', hint: "don't show this again" });
    options.push({ value: 'quit', label: 'Quit', hint: 'abort this run' });

    const choice = await p.select({ message: 'What would you like to do?', options });
    if (isCancelled(choice) || choice === 'quit') {
      p.cancel('Aborted by user.');
      process.exit(0);
    }

    if (choice === 'discard') {
      saveDismissedHint(ctx.projectRoot, hint.id);
      continue;
    }

    if (choice === 'run' && hint.command) {
      const result = spawnSync(process.argv[0]!, [process.argv[1]!, ...hint.command.argv], {
        stdio: 'inherit',
      });
      process.exit(result.status ?? 0);
    }
  }
}
