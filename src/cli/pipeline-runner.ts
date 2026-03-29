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
import { GeminiCircuitBreaker } from '../core/circuit-breaker.js';
import type { DocExecutor } from '../core/doc-llm-executor.js';
import { retryWithBackoff, RateLimitStandbyError } from '../utils/rate-limiter.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { checkGeminiAuth } from '../utils/gemini-auth.js';
import { TransportRouter } from '../core/transports/index.js';
import { AnthropicTransport } from '../core/transports/anthropic-transport.js';
import { GeminiTransport } from '../core/transports/gemini-transport.js';
import { VercelSdkTransport } from '../core/transports/vercel-sdk-transport.js';

// --- Public interfaces ---

export interface PipelineTask {
  id: string;
  label: string;
}

/**
 * Runtime context passed to the {@link PipelineOptions.execute} callback.
 *
 * Bundles every resource the execute function needs so callers never have to
 * wire up boilerplate themselves.
 *
 * @property projectRoot - Absolute path to the project being processed.
 * @property config - Resolved Anatoly configuration (merged defaults + user overrides).
 * @property pkg - Parsed `package.json` contents, or `{}` for non-Node projects.
 * @property docsPath - Relative path to the documentation directory (from config).
 * @property profile - Detected language/framework/type profile of the project.
 * @property semaphore - Concurrency gate for SDK calls; callers acquire/release
 *   it themselves to avoid deadlocks.
 * @property executor - LLM dispatch abstraction — sends a system+user prompt
 *   pair to the configured model and returns the response text plus cost.
 * @property state - Mutable pipeline state used to track task progress.
 * @property renderer - Screen renderer that redraws task status on each tick.
 * @property plain - When `true`, output is plain text (no ANSI escape codes).
 * @property addCost - Callback that accumulates incremental LLM cost (in USD)
 *   into the pipeline's running total, returned in {@link PipelineResult}.
 */
export interface PipelineContext {
  projectRoot: string;
  config: Config;
  pkg: Record<string, unknown>;
  docsPath: string;
  profile: ProjectProfile;
  semaphore: Semaphore;
  /** Gemini-specific concurrency semaphore — created only when Gemini is enabled. */
  geminiSemaphore?: Semaphore;
  /** Circuit breaker for Gemini fallback — created only when Gemini is enabled. */
  circuitBreaker?: GeminiCircuitBreaker;
  executor: DocExecutor;
  state: PipelineState;
  renderer: ScreenRenderer;
  plain: boolean;
  addCost: (usd: number) => void;
  /** Mode-aware transport router for LLM call routing. */
  router: TransportRouter;
}

/**
 * Options accepted by {@link runPipeline} to configure and execute a pipeline.
 *
 * @property projectRoot - Absolute path to the project root directory.
 * @property plain - When `true`, disables ANSI styling and box-drawing; emits
 *   plain-text task progress to stdout instead.
 * @property bannerMotd - "Message of the day" string shown in the startup
 *   banner (e.g. `"Doc Scaffold"`, `"Review"`).
 * @property tasks - Ordered list of pipeline tasks to register in the state
 *   tracker before execution begins.
 * @property showProfile - Whether to print the detected language/framework
 *   profile below the banner. Defaults to `true`.
 * @property execute - User-supplied async callback that performs the actual
 *   work. It receives a fully-initialised {@link PipelineContext} and should
 *   drive task state transitions and call `ctx.addCost()` as costs accrue.
 *   Errors thrown from this callback are re-thrown after the renderer is stopped.
 */
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

/**
 * Orchestrates a full pipeline run: loads config, detects the project profile,
 * wires up the screen renderer, prints the banner, then delegates to the
 * user-supplied {@link PipelineOptions.execute} callback.
 *
 * In plain mode, task state transitions are logged as simple console lines
 * instead of being rendered with ANSI redraws.
 *
 * @param opts - Pipeline configuration and the async execute callback.
 * @returns A {@link PipelineResult} containing the wall-clock duration and
 *   the accumulated LLM cost in USD.
 * @throws Re-throws any error raised by `opts.execute` after the renderer has
 *   been cleanly stopped.
 */
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

  // Gemini auth check — graceful fallback to Claude if auth fails
  let geminiEnabled = !!config.providers.google;
  if (geminiEnabled) {
    const googleConfig = config.providers.google!;
    const geminiModel = Object.values(config.axes).map(a => a.model).find(m => m?.startsWith('gemini-'))
      ?? config.models.code_summary?.startsWith('gemini-') ? config.models.code_summary! : 'gemini-2.5-flash';
    if (googleConfig.mode === 'api') {
      if (!process.env.GEMINI_API_KEY) {
        console.log(chalk.yellow('⚠ Gemini API mode but GEMINI_API_KEY not set. Fallback Claude.'));
        geminiEnabled = false;
      }
    } else {
      const authOk = await checkGeminiAuth(projectRoot, geminiModel);
      if (!authOk) {
        console.log(chalk.yellow('⚠ Gemini activé mais auth Google introuvable. Fallback Claude.'));
        geminiEnabled = false;
      }
    }
  }

  // Build mode-aware transport router
  const nativeTransports: Record<string, import('../core/transports/index.js').LlmTransport> = {
    anthropic: new AnthropicTransport(),
  };
  if (geminiEnabled) {
    const geminiModel = Object.values(config.axes).map(a => a.model).find(m => m?.startsWith('gemini-')) ?? 'gemini-2.5-flash';
    nativeTransports.google = new GeminiTransport(projectRoot, geminiModel);
  }
  const providerModes: Record<string, import('../core/transports/index.js').ProviderModeConfig> = {};
  for (const [id, prov] of Object.entries(config.providers)) {
    if (prov) providerModes[id] = { mode: prov.mode, single_turn: prov.single_turn, agents: prov.agents };
  }
  const router = new TransportRouter({
    nativeTransports,
    vercelSdkTransport: new VercelSdkTransport(config),
    providerModes,
  });

  const semaphore = new Semaphore(config.providers.anthropic?.concurrency ?? 24);
  const geminiSemaphore = geminiEnabled
    ? new Semaphore(config.providers.google!.concurrency)
    : undefined;
  const circuitBreaker = geminiEnabled
    ? new GeminiCircuitBreaker()
    : undefined;
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
    geminiSemaphore,
    circuitBreaker,
    executor,
    state,
    renderer,
    plain,
    addCost: (usd: number) => { totalCostUsd += usd; },
    router,
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
    }
    throw err;
  } finally {
    renderer.stop();
  }

  const durationMs = Date.now() - startTime;
  return { durationMs, totalCostUsd };
}

// --- Internal ---

/**
 * Creates a {@link DocExecutor} that dispatches LLM calls via the Claude Agent
 * SDK with automatic retry and exponential back-off on rate-limit errors.
 *
 * **Important:** the provided semaphore is intentionally *not* acquired inside
 * this executor. Callers (e.g. `executeDocPrompts`, `runDocUpdate`) manage
 * their own concurrency control to avoid deadlocks.
 *
 * @param projectRoot - Absolute path used as the SDK working directory.
 * @param _semaphore - Reserved for future use; concurrency is managed externally.
 * @returns An async executor function conforming to the {@link DocExecutor} contract.
 */
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
        let rateLimitResetsAt: number | undefined;

        for await (const message of q) {
          // Detect tier-level rate limit event
          if (message.type === 'rate_limit_event') {
            const info = (message as Record<string, unknown>).rate_limit_info as
              { status?: string; resetsAt?: number } | undefined;
            if (info?.status === 'rejected' && typeof info.resetsAt === 'number') {
              rateLimitResetsAt = info.resetsAt * 1000;
            }
          }

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

        // Tier-level rate limit: SDK returned "success" with rate limit text
        if (rateLimitResetsAt != null && costUsd === 0) {
          throw new RateLimitStandbyError(rateLimitResetsAt);
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
        onStandby: (resetsAtMs) => {
          const MARGIN_MS = 5 * 60 * 1000;
          const resumeStr = new Date(resetsAtMs + MARGIN_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          console.log(`  sleeping until ${resumeStr} (rate limit)`);
        },
      },
    );
  };
}
