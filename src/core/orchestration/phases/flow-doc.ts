// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Flow-doc phase (doc 23, Stage 2) — narrates the deterministic user-flow
 * skeleton into a human-readable, ratifiable page.
 *
 * The `flows` phase (Stage 1) already wrote the structured artifact
 * (`.anatoly/state/internal-flows/flows.json`) with NO LLM. This phase reads
 * that artifact, grounds the agentic Read-only doc writer on its literal facts,
 * and writes the narrated page to `.anatoly/state/internal-flows/user-flows.md`.
 * It reuses the SAME transport + doc-writer mechanism as `anatoly docs` (doc 23
 * I6 — no new transport) and emits ZERO scored findings (I1): the page is an
 * internal-flows doc-source, context-only and never project-scored.
 *
 * Gating (mirrors the flows phase + the doc invariants):
 *  - disabled (`!ctx.flows`) ⇒ no-op;
 *  - page already present ⇒ never overwritten (the page is human-ratifiable per
 *    doc 23 §3/§6 — regeneration would clobber edits), idempotent skip;
 *  - no flows artifact ⇒ skip (the artifact only exists when the flows phase ran
 *    with RAG on, so this transitively satisfies I4: RAG-off ⇒ no content);
 *  - empty / unreadable artifact ⇒ skip.
 *
 * The narration NEVER asserts what the code SHOULD do (I3): the writer's system
 * prompt forbids it and the grounding carries only the literal skeleton. Page
 * caps (flows-per-page, steps-per-flow) keep it conservative (I5).
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isFatalAuthError, isAuthFailureMessage, authError } from '../../../utils/errors.js';
import { getLogger } from '../../../utils/logger.js';
import { runWithContext } from '../../../utils/log-context.js';
import { retryWithBackoff } from '../../../utils/rate-limiter.js';
import { withTimeout } from '../../../utils/with-timeout.js';
import { conversationsDir } from '../../../utils/run-layout.js';
import { UserFlowArtifactSchema, type UserFlow } from '../../../schemas/user-flow.js';
import { flowArtifactPath, flowDocPagePath, buildFlowDocPrompt } from '../../flows/index.js';
import type { DocExecutor } from '../../documentation/index.js';
import { recordDocGenerationCost } from '../cost.js';
import { requestFatalStop } from '../run-control.js';
import type { RunContext } from '../../../commands/run.js';

/**
 * Build the agentic Read-only doc executor for the single flow-doc page.
 *
 * Mirrors the doc-generation executor (doc.ts) but owns its slot: there is no
 * surrounding `executeDocPrompts` holding a router slot here, so this acquires
 * exactly one provider slot (circuit-breaker + concurrency accounting see the
 * call) and resolves the transport directly — NOT `router.agenticQuery`, which
 * would acquire a second slot — then owns the retry and per-call wall-clock
 * budget (the SDK agentic loop has no internal timeout).
 */
export function createFlowDocExecutor(ctx: RunContext): DocExecutor {
  const timeoutMs = ctx.config.runtime.timeout_per_call * 1000;
  return async ({ system, user, model }) => {
    const router = ctx.router;
    if (!router) throw new Error('flow-doc: no router available');

    const { release } = await router.acquireSlot(model);
    const transport = router.resolve(model, 'agents');
    if (!transport.agenticQuery) {
      release({ success: false });
      throw new Error(`Transport '${transport.provider}' does not support agentic queries`);
    }

    // Per-call abort + wall-clock budget, registered in activeAborts so SIGINT
    // cancels it too.
    const pageAc = new AbortController();
    ctx.activeAborts.add(pageAc);
    let success = false;
    let failErr: unknown;
    try {
      const callId = `flow-doc-${Date.now()}`;
      const response = await withTimeout(
        () => retryWithBackoff(
          () => runWithContext(
            { composer: 'flow.doc', primitive: 'flow.page', callId },
            () => transport.agenticQuery!({
              systemPrompt: system,
              userMessage: user,
              model,
              projectRoot: ctx.projectRoot,
              abortController: pageAc,
              allowedTools: ['Read'],
              maxTurns: ctx.config.agents.max_turns,
              config: ctx.config,
              conversationDir: conversationsDir(ctx.runDir),
              attempt: 1,
            }),
          ),
          {
            maxRetries: 5,
            baseDelayMs: 5_000,
            maxDelayMs: 60_000,
            jitterFactor: 0.2,
            filePath: 'flow-doc',
            isInterrupted: () => ctx.interrupted || pageAc.signal.aborted,
            onRetry: (attempt, delayMs) =>
              getLogger().warn({ attempt, delayMs }, 'flow-doc generation retrying'),
          },
        ),
        {
          timeoutMs,
          label: 'flow-doc page generation',
          onTimeout: () => pageAc.abort(),
        },
      );
      success = true;
      return { text: response.text, costUsd: response.costUsd };
    } catch (err) {
      failErr = err;
      throw err;
    } finally {
      ctx.activeAborts.delete(pageAc);
      release({ success, error: failErr });
    }
  };
}

/**
 * Narrate the user-flow page from the deterministic artifact. The `executor`
 * dep is injectable so tests drive it hermetically (no real LLM); production
 * defaults to {@link createFlowDocExecutor}.
 */
export async function runFlowDocPhase(
  ctx: RunContext,
  deps: { executor?: DocExecutor } = {},
): Promise<void> {
  const log = getLogger();

  // (a) Disabled ⇒ no-op.
  if (!ctx.flows) return;

  const pagePath = flowDocPagePath(ctx.projectRoot);

  // (b) Never overwrite a present page: it is human-ratifiable (doc 23 §3/§6).
  if (existsSync(pagePath)) {
    ctx.pipelineState?.completeTask('flow-doc', 'page exists');
    return;
  }

  // (c) No deterministic skeleton ⇒ nothing to narrate. The artifact only
  // exists when the flows phase ran (RAG on), so this transitively enforces I4.
  const artifactPath = flowArtifactPath(ctx.projectRoot);
  if (!existsSync(artifactPath)) {
    ctx.pipelineState?.completeTask('flow-doc', 'skipped (no flows artifact)');
    return;
  }

  let flows: UserFlow[];
  try {
    const raw: unknown = JSON.parse(readFileSync(artifactPath, 'utf-8'));
    flows = UserFlowArtifactSchema.parse(raw).flows;
  } catch (err) {
    log.warn({ err: String(err), artifactPath }, 'flow-doc: unreadable flows artifact — skipping');
    ctx.pipelineState?.completeTask('flow-doc', 'skipped (bad artifact)');
    return;
  }

  const prompt = buildFlowDocPrompt(flows);
  if (!prompt) {
    // Empty artifact: nothing to narrate (bench-neutral no-op).
    ctx.pipelineState?.completeTask('flow-doc', 'no flows');
    return;
  }

  ctx.pipelineState?.startTask('flow-doc', 'narrating user-flow page…');

  const executor = deps.executor ?? createFlowDocExecutor(ctx);
  const phaseStart = Date.now();

  try {
    const result = await executor(prompt);

    // Strip any preamble before the first markdown heading (mirrors executeOnePage).
    let content = result.text;
    const headingIdx = content.search(/^# /m);
    if (headingIdx > 0) content = content.slice(headingIdx);

    mkdirSync(dirname(pagePath), { recursive: true });
    writeFileSync(pagePath, content, 'utf-8');

    recordDocGenerationCost(ctx, 'flow-doc', {
      costUsd: result.costUsd,
      durationMs: Date.now() - phaseStart,
      calls: 1,
    });

    log.info({ pagePath, costUsd: result.costUsd }, 'flow-doc: user-flow page generated');
    ctx.pipelineState?.completeTask('flow-doc', 'page generated');
  } catch (err) {
    const e = err as Error;
    // A provider-auth failure is run-fatal — stop now (mirrors doc generation).
    if (isFatalAuthError(e) || isAuthFailureMessage(e.message)) {
      requestFatalStop(ctx, isFatalAuthError(e) ? e : authError('anthropic'));
      return;
    }
    log.warn({ pagePath, err: e.message }, 'flow-doc: user-flow page generation failed');
    ctx.pipelineState?.completeTask('flow-doc', 'failed');
  }
}
