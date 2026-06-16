// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Flows phase (doc 23, Stage 1) — a dedicated, independently-toggleable
 * pipeline phase, NOT an axis.
 *
 * Runs right after the RAG phase (the cards + usage graph it reads are in
 * memory by then) and before review. It is a pure, deterministic graph walk
 * with NO LLM: it derives the `UserFlow` skeletons from the RAG function cards
 * and the import/usage graph and writes them to the canonical state artifact
 * (`.anatoly/state/internal-flows/flows.json`). It emits ZERO scored findings
 * (doc 23 invariant I1), so it is bench-neutral and safe to leave off by
 * default during bring-up.
 *
 * Gating mirrors the invariants phase: disabled ⇒ no-op; RAG off / no vector
 * store ⇒ no-op (the cards + graph are the only inputs, so there is nothing to
 * walk). The flag is resolved onto RunContext from --flows / config.flows.enabled
 * (default false).
 */

import { getLogger } from '../../../utils/logger.js';
import { buildFlowSkeletons, writeFlowArtifact } from '../../flows/index.js';
import type { RagContext, Handoff } from '../handoff.js';
import type { RunContext } from '../../../commands/run.js';

export async function runFlowsPhase(
  ctx: RunContext,
  handoff: Handoff,
  ragContext: RagContext,
): Promise<void> {
  const log = getLogger();

  // (a) Disabled ⇒ no-op.
  if (!ctx.flows) return;

  // (b) RAG is the only candidate source (cards + usage graph). RAG off / no
  // store ⇒ zero inputs ⇒ no-op (accepted by design — Stage 1 is RAG-only).
  const vectorStore = ragContext.vectorStore;
  if (!ragContext.ragEnabled || !vectorStore) {
    ctx.pipelineState?.completeTask('flows', 'skipped (rag inactive)');
    return;
  }

  // The usage graph is the setup phase's import/reference graph. Without it the
  // cross-file edges cannot resolve, so there is nothing trustworthy to walk.
  const usageGraph = handoff.usageGraph;
  if (!usageGraph) {
    ctx.pipelineState?.completeTask('flows', 'skipped (no usage graph)');
    return;
  }

  ctx.pipelineState?.startTask('flows', 'modeling user flows…');

  const cards = await vectorStore.listAll();
  if (cards.length === 0) {
    // Still write an (empty) artifact so a stale prior artifact never lingers.
    writeFlowArtifact(ctx.projectRoot, []);
    ctx.pipelineState?.completeTask('flows', 'no cards');
    return;
  }

  const flows = buildFlowSkeletons({ cards, usageGraph });
  const artifactPath = writeFlowArtifact(ctx.projectRoot, flows);

  const unwired = flows.filter((f) => f.unwired).length;
  log.info(
    `flows: modeled ${flows.length} user flow(s) from ${cards.length} card(s)` +
      (unwired > 0 ? `, ${unwired} unwired` : '') +
      ` → ${artifactPath}`,
  );
  ctx.pipelineState?.completeTask(
    'flows',
    flows.length === 0 ? 'no flows' : `${flows.length} flow(s)`,
  );
}
