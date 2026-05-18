// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Refinement phase (extracted from run.ts in PR 6, doc 11 Strategy B).
 *
 * Move-only: this was an inline closure passed to
 * `runPhase(ctx, 'refinement', async () => { ... })` in the spine. The
 * closure body is reproduced byte-verbatim below as the function body; the
 * only captured spine variables were `ctx` and `setup`, now parameters.
 * The gate (`ctx.deliberation && handoff.filesReviewed > 0 && !ctx.interrupted`)
 * and the `runPhase('refinement', ...)` wrapper stay in the orchestration
 * spine (see the post-PR-8 note below for its current location and call).
 *
 * Named `runRefinementStage`, not `runRefinementPhase`: the latter is the
 * imported core refinement engine (core/refinement/phase.js) this stage
 * wraps. Keeping the engine import un-aliased keeps the body byte-verbatim
 * (zero in-body edits). `RunContext` is type-only (erased); `SetupResult`
 * comes from the typed handoff contract. Import list seeded from run.ts
 * (path-rewritten) then pruned.
 *
 * Post-PR-8 state (doc 11): the orchestration spine lives in
 * pipeline.ts (PR 8a), not run.ts; this phase receives the typed
 * `Handoff` object explicitly as a parameter (PR 8c) and the §4
 * inter-phase data is no longer `ctx` mutation. Any line above
 * describing a run.ts call site, `ctx`-mutation, or "handoff
 * untouched until PR 8" is extraction-era history, superseded here.
 */

import { join } from 'node:path';
import { writeReviewOutput } from '../../reporting/index.js';
import { loadReviews } from '../../reporting/index.js';
import { getLogger } from '../../../utils/logger.js';
import { recordReclassification } from '../../platform/index.js';
import { DeliberationResponseSchema } from '../../deliberation.js';
import { extractJson } from '../../../utils/extract-json.js';
import { runRefinementPhase } from '../../refinement/phase.js';
import { recordLlmCost } from '../cost.js';
import type { RunContext } from '../../../commands/run.js';
import type { SetupResult, Handoff } from '../handoff.js';

export async function runRefinementStage(ctx: RunContext, handoff: Handoff, setup: SetupResult): Promise<void> {
            ctx.pipelineState?.startTask('refinement', 'auto-resolve');

            const refinementStart = Date.now();
            const refinementResult = await runRefinementPhase({
              projectRoot: ctx.projectRoot,
              runDir: ctx.runDir,
              config: ctx.config,
              usageGraph: setup.usageGraph,
              fileContents: new Map(), // Tier 1 reads files on demand
              preResolvedRag: new Map(), // RAG results are per-file, not cached globally
              abortController: (() => { const ac = new AbortController(); ctx.activeAborts.add(ac); return ac; })(),
              deliberation: ctx.deliberation,
              freshFiles: ctx.freshFiles,
              plain: ctx.plain,
              loadReviewsFn: (pr, rd) => loadReviews(pr, rd),
              writeReviewFn: (review) => writeReviewOutput(ctx.projectRoot, review, ctx.runDir),
              queryFn: async (params) => {
                const response = await ctx.router!.agenticQuery({
                  systemPrompt: params.systemPrompt,
                  userMessage: params.userMessage,
                  model: params.model,
                  projectRoot: params.projectRoot,
                  abortController: params.abortController,
                  allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
                  maxTurns: ctx.config.agents.max_turns,
                  config: ctx.config,
                  conversationDir: join(ctx.runDir, 'conversations'),
                  conversationPrefix: `tier3-shard-${Date.now()}`,
                  attempt: 1,
                  responseSchema: DeliberationResponseSchema,
                });

                const jsonStr = extractJson(response.text);
                if (!jsonStr) {
                  throw new Error('Tier 3: no valid JSON found in agentic response');
                }
                const parsed = DeliberationResponseSchema.parse(JSON.parse(jsonStr));

                return {
                  data: parsed,
                  costUsd: response.costUsd,
                  durationMs: response.durationMs,
                  inputTokens: response.inputTokens,
                  outputTokens: response.outputTokens,
                  cacheReadTokens: response.cacheReadTokens,
                  cacheCreationTokens: response.cacheCreationTokens,
                  transcript: response.transcript,
                };
              },
              recordFn: (pr, entry) => recordReclassification(pr, entry),
              onProgress: (event, detail) => {
                const state = ctx.pipelineState;
                if (!state) return;
                switch (event) {
                  case 'tier1-done':
                    state.updateTask('refinement', `auto-resolve done (${detail})`);
                    break;
                  case 'tier2-done':
                    state.updateTask('refinement', `coherence done (${detail})`);
                    break;
                  case 'tier3-shard':
                    state.updateTask('refinement', detail ?? '');
                    break;
                  case 'tier3-done':
                    state.completeTask('refinement', detail ?? 'done');
                    break;
                }
                // Plain mode sequential logging (use logPlain to bypass console.log suppression)
                if (ctx.plain && event === 'tier3-shard') {
                  ctx.renderer?.logPlain(`[deliberation]   ${detail}`);
                }
                if (ctx.plain && event.endsWith('-done')) {
                  ctx.renderer?.logPlain(`[deliberation] \u2714 ${detail}`);
                }
              },
            });

            const refinementDuration = Date.now() - refinementStart;

            // Update findings counter to reflect post-refinement net
            const totalResolved = refinementResult.tier1Stats.resolved
              + refinementResult.tier2Stats.resolved
              + refinementResult.tier3Stats.reclassified;
            handoff.totalFindings = Math.max(0, handoff.totalFindings - totalResolved);

            // Tier 3 invokes Claude SDK; tiers 1+2 are deterministic so the
            // cost is fully attributable to anthropic. `investigated` is the
            // SDK call count; `totalCostUsd` is the rolled-up cost.
            recordLlmCost(ctx, {
              provider: 'anthropic',
              phase: 'refinement',
              costUsd: refinementResult.totalCostUsd,
              durationMs: refinementDuration,
              calls: refinementResult.tier3Stats.investigated,
              inputTokens: refinementResult.totalInputTokens,
              outputTokens: refinementResult.totalOutputTokens,
              cacheReadTokens: refinementResult.totalCacheReadTokens,
              cacheCreationTokens: refinementResult.totalCacheCreationTokens,
            });

            getLogger().info({
              phase: 'refinement',
              tier1Resolved: refinementResult.tier1Stats.resolved,
              tier2Resolved: refinementResult.tier2Stats.resolved,
              tier2Escalated: refinementResult.tier2Stats.escalated,
              tier3Investigated: refinementResult.tier3Stats.investigated,
              tier3Reclassified: refinementResult.tier3Stats.reclassified,
              totalResolved,
              costUsd: refinementResult.totalCostUsd,
              durationMs: refinementDuration,
            }, 'refinement phase complete');
}
