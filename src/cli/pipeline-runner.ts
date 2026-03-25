// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Shared pipeline runner — centralizes the boilerplate for any command
 * that needs PipelineState + ScreenRenderer + banner + cost tracking.
 *
 * Usage:
 *   await runPipeline({
 *     projectRoot,
 *     plain: false,
 *     bannerMotd: 'Doc Scaffold',
 *     tasks: [{ id: 'scaffold', label: 'Scaffolding docs' }],
 *     execute: async (ctx) => {
 *       ctx.state.startTask('scaffold', 'working…');
 *       // … do work …
 *       ctx.addCost(result.costUsd);
 *       ctx.state.completeTask('scaffold', 'done');
 *     },
 *   });
 */

import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PipelineState } from './pipeline-state.js';
import { ScreenRenderer } from './screen-renderer.js';
import { printBanner } from '../utils/banner.js';
import { loadConfig } from '../utils/config-loader.js';
import type { Config } from '../schemas/config.js';
import { detectProjectProfile, formatLanguageLine, formatFrameworkLine, type ProjectProfile } from '../core/language-detect.js';
import { Semaphore } from '../core/sdk-semaphore.js';
import type { DocExecutor } from '../core/doc-llm-executor.js';
import { retryWithBackoff } from '../utils/rate-limiter.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

// --- Public interfaces ---

export interface PipelineTask {
  id: string;
  label: string;
}

export interface PipelineContext {
  projectRoot: string;
  config: Config;
  pkg: Record<string, unknown>;
  docsPath: string;
  profile: ProjectProfile;
  semaphore: Semaphore;
  executor: DocExecutor;
  state: PipelineState;
  renderer: ScreenRenderer;
  plain: boolean;
  addCost: (usd: number) => void;
}

export interface PipelineOptions {
  projectRoot: string;
  plain: boolean;
  bannerMotd: string;
  tasks: PipelineTask[];
  showProfile?: boolean;
  execute: (ctx: PipelineContext) => Promise<void>;
}

export interface PipelineResult {
  durationMs: number;
  totalCostUsd: number;
}

// --- Main entry point ---

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { projectRoot, plain, bannerMotd, tasks, execute } = opts;
  const showProfile = opts.showProfile ?? true;

  const config = loadConfig(projectRoot);
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    // No package.json (Go, Rust, Python projects) — continue with empty manifest
  }
  const docsPath = config.documentation?.docs_path ?? 'docs';
  const profile = detectProjectProfile(projectRoot);
  const semaphore = new Semaphore(config.llm.sdk_concurrency);
  const executor = createExecutor(projectRoot, semaphore);

  let totalCostUsd = 0;
  const startTime = Date.now();

  // Pipeline state + renderer
  const state = new PipelineState();
  state.setSemaphore(semaphore);
  for (const task of tasks) {
    state.addTask(task.id, task.label);
  }
  const renderer = new ScreenRenderer(state, { plain });

  // Banner + project info
  if (!plain) {
    printBanner(bannerMotd);
    if (showProfile) {
      const langLine = formatLanguageLine(profile.languages.languages);
      const fwLine = formatFrameworkLine(profile.frameworks);
      if (langLine) console.log(`  ${chalk.dim('languages')}  ${langLine}`);
      if (fwLine) console.log(`  ${chalk.dim('frameworks')} ${fwLine}`);
      console.log(`  ${chalk.dim('types')}      ${profile.types.join(', ')}`);
      console.log('');
    }
  }

  const ctx: PipelineContext = {
    projectRoot,
    config,
    pkg,
    docsPath,
    profile,
    semaphore,
    executor,
    state,
    renderer,
    plain,
    addCost: (usd: number) => { totalCostUsd += usd; },
  };

  // In plain mode, log task transitions to console
  if (plain) {
    const origStart = state.startTask.bind(state);
    state.startTask = (id: string, detail?: string) => {
      origStart(id, detail);
      const task = state.tasks.find(t => t.id === id);
      if (task) console.log(`  ● ${task.label}${detail ? ` — ${detail}` : ''}`);
    };
    const origUpdate = state.updateTask.bind(state);
    state.updateTask = (id: string, detail: string) => {
      origUpdate(id, detail);
      const task = state.tasks.find(t => t.id === id);
      if (task) console.log(`  … ${task.label} — ${detail}`);
    };
    const origComplete = state.completeTask.bind(state);
    state.completeTask = (id: string, detail: string) => {
      const task = state.tasks.find(t => t.id === id);
      origComplete(id, detail);
      if (task) console.log(`  ✓ ${task.label} — ${detail}`);
    };
  }

  renderer.start();
  try {
    await execute(ctx);
  } catch (err) {
    if (plain) {
      console.error(`  ${chalk.red('×')} Pipeline error: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
    }
    throw err;
  } finally {
    renderer.stop();
  }

  const durationMs = Date.now() - startTime;
  return { durationMs, totalCostUsd };
}

// --- Internal ---

function createExecutor(projectRoot: string, _semaphore: Semaphore): DocExecutor {
  // Note: semaphore is NOT acquired here — callers (executeDocPrompts, runDocUpdate)
  // handle their own concurrency control. Acquiring here would cause deadlocks.
  return async ({ system, user, model }) => {
    return retryWithBackoff(
      async () => {
        const q = query({
          prompt: user,
          options: {
            systemPrompt: system,
            model,
            cwd: projectRoot,
            allowedTools: [],
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
          },
        });

        let resultText = '';
        let costUsd = 0;

        for await (const message of q) {
          if (message.type === 'result') {
            if (message.subtype === 'success') {
              resultText = (message as { result: string }).result;
              costUsd = (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
            } else {
              const errMsg = (message as { errors?: string[] }).errors?.join(', ') ?? message.subtype;
              throw new Error(`SDK error [${message.subtype}]: ${errMsg}`);
            }
          }
        }

        if (!resultText) {
          throw new Error('SDK returned no result — LLM stream was empty');
        }

        return { text: resultText, costUsd };
      },
      {
        maxRetries: 5,
        baseDelayMs: 5_000,
        maxDelayMs: 60_000,
        jitterFactor: 0.2,
        filePath: 'doc-executor',
        onRetry: (attempt, delayMs) => {
          console.log(`  rate limited — retry ${attempt}/5 in ${(delayMs / 1000).toFixed(0)}s`);
        },
      },
    );
  };
}
