// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * The orchestration pipeline (extracted from run.ts in PR 8a, doc 11
 * Strategy B). This is the spine: the canonical phase sequence, the gates,
 * the `runPhase` wrappers and the interrupt handling. It was the
 * `await runWithContext({ runId }, async () => { ... })` block inside the
 * `run` command's `.action()`; the body below is byte-verbatim.
 *
 * `run.ts` keeps process lifecycle only (CLI parse, RunContext build,
 * router, lock/SIGINT, the try/catch/finally and teardown) and calls
 * `runPipeline(ctx, deps)`. The spine's captured non-ctx bindings
 * (`runId`, `projectRoot`, `cmdOpts.notify`, `initRunDir`) are passed as
 * `deps`; the destructuring line is the only glue, the rest is verbatim.
 *
 * `loadArbitratedFragments` was a run.ts-local helper used only by the
 * spine, so it moves here as a module-private function (relocated
 * verbatim). `RunContext` is type-only (erased): no runtime dependency on
 * the commands layer. Import list seeded from run.ts (path-rewritten)
 * then pruned. PR 8a (this extraction) is move-only; PR 8c then
 * replaced the §4 ctx-mutation handoff with the typed `Handoff`
 * object, created here via createHandoff() and passed explicitly to
 * every phase.
 */

import { createHandoff } from './handoff.js';
import type { Handoff } from './handoff.js';
import { bootstrapDocGate, internalDocsGate, refinementGate } from './gates.js';
import type { ResolvedModels } from '../../rag/hardware-detect.js';
import { acquireLock, releaseLock } from '../../utils/lock.js';
import { sendDesktopNotification } from '../notifications/desktop.js';
import { getLogger } from '../../utils/logger.js';
import { enterLlmCallSink } from '../../utils/llm-calls-sink.js';
import { costsLedgerPath } from '../../utils/run-layout.js';
import { runWithContext } from '../../utils/log-context.js';
import { isDocAxisActive } from '../evaluation/index.js';
import { formatRunDuration } from '../../utils/format.js';
import { PipelineState } from '../../cli/pipeline-state.js';
import { ScreenRenderer } from '../../cli/screen-renderer.js';
import { needsBootstrap, writeScaffoldStatus } from '../documentation/index.js';
import { anatolyPath } from '../../utils/anatoly-paths.js';
import { runDocConflictDetection } from '../documentation/index.js';
import { recordDocConflictCost } from './cost.js';
import { runPhase } from './run-phase.js';
import { runReportPhase } from './phases/report.js';
import { runSetupPhase } from './phases/setup.js';
import { runRagPhase } from './phases/rag.js';
import { runDocBootstrap, runDocUpdate, reindexDocsAfterUpdate } from './phases/doc.js';
import { runRefinementStage } from './phases/refinement.js';
import { runReviewPhase } from './phases/review.js';
import { runInvariantsPhase } from './phases/invariants.js';
import { runFlowsPhase } from './phases/flows.js';
import { runFlowDocPhase } from './phases/flow-doc.js';
import { loadDocConflicts } from '../documentation/index.js';
import type { ArbitratedFragment } from '../evaluation/index.js';
import type { RunContext } from '../../commands/run.js';

/** Non-ctx bindings the spine captured from the run command's .action() scope. */
export interface PipelineDeps {
  /** Pre-pipeline pricing pre-flight value (run.ts), seeds handoff.resolvedModels. */
  resolvedModels?: ResolvedModels;
  runId: string;
  projectRoot: string;
  cmdOpts: { notify?: boolean };
  initRunDir: () => void;
}

// ---------------------------------------------------------------------------
// Story 55.7: Extract doc-wins arbitrated fragments from doc-conflicts.yaml
// ---------------------------------------------------------------------------

function loadArbitratedFragments(projectRoot: string): ArbitratedFragment[] {
  try {
    const lock = loadDocConflicts(projectRoot);
    if (!lock) return [];
    return lock.entries
      .filter((e) => e.verdict === 'doc-wins' && e.status === 'applied')
      .map((e) => ({
        referencePath: e.reference_excerpt.path,
        lineRange: e.reference_excerpt.line_range,
        text: e.reference_excerpt.text,
        arbitratedAt: e.verdict_set_at ?? e.detected_at,
        note: e.verdict_note,
      }));
  } catch {
    return [];
  }
}

/**
 * doc 14 PR 5: the triplicated `if (ctx.interrupted) { ...summary...; return }`
 * tail block collapses to this one helper (the spine still does the
 * `return`). Byte-verbatim body of the former blocks; the pre-review
 * `0/${setup.files}` variant is intentionally NOT this (different shape).
 */
function emitInterruptSummary(ctx: RunContext, handoff: Handoff): void {
  const inFlight = ctx.activeAborts.size;
  const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
  console.log(`interrupted — ${handoff.filesReviewed}/${handoff.totalFiles} files reviewed | ${handoff.totalFindings} findings${inFlightNote} | ${formatRunDuration(Date.now() - ctx.startTime)}`);
  if (ctx.lockPath) releaseLock(ctx.lockPath);
  ctx.lockPath = undefined;
}

/**
 * One-line TUI/task detail for a completed doc-conflict phase. Structurally
 * typed (subset of `DetectionSummary`) so this module needn't import the
 * detector's public type.
 */
function formatDocConflictDetail(
  dc: { newConflicts: number; applied: number; stale: number; pending: number },
): string {
  if (dc.newConflicts === 0 && dc.applied === 0 && dc.stale === 0 && dc.pending === 0) {
    return 'clean';
  }
  return `${dc.newConflicts} new · ${dc.applied} applied · ${dc.pending} pending`;
}

export async function runPipeline(ctx: RunContext, deps: PipelineDeps): Promise<void> {
  const { runId, projectRoot, cmdOpts, initRunDir } = deps;
  const handoff = createHandoff({ resolvedModels: deps.resolvedModels });
        await runWithContext({ runId }, async () => {
        const setup = await runSetupPhase(ctx, handoff);
        if (ctx.dryRun) return;
        if (ctx.interrupted) {
          console.log(`interrupted — 0/${setup.files} files reviewed | 0 findings | ${formatRunDuration(Date.now() - ctx.startTime)}`);
          return;
        }

        // User confirmed the pipeline summary — materialize the run dir now.
        initRunDir();

        // Open the per-call LLM sink for the remainder of the run. Transports
        // emit records via recordLlmCall(), persisted to costs/ledger.ndjson.
        enterLlmCallSink(costsLedgerPath(ctx.runDir));

        // Detect first run — Story 29.21. The doc ledger lives next to the
        // docs under ctx.projectRoot (runDocScaffold/runDocGeneration write
        // there), so all flag I/O uses ctx.projectRoot. In non-worktree runs
        // this equals the old effectiveSourceRoot; in worktree it now
        // correctly points where the docs actually are.
        handoff.isFirstRun = needsBootstrap(ctx.projectRoot);

        // Initialize pipeline display
        const pipelineState = new PipelineState();
        if (ctx.router) {
          pipelineState.setRouter(ctx.router);
        }
        if (handoff.isFirstRun && isDocAxisActive(ctx)) {
          pipelineState.addTask('bootstrap-doc', 'Bootstrapping internal docs');
          pipelineState.addTask('doc-conflict-bootstrap', 'Detecting doc conflicts (bootstrap)');
        }
        if (ctx.enableRag) {
          pipelineState.addTask('rag-code', 'Embedding code');
          pipelineState.addTask('rag-nlp', 'LLM summaries & embedding');
          pipelineState.addTask('rag-doc-project', 'Chunking & embedding project docs');
          pipelineState.addTask('rag-doc-internal', 'Chunking & embedding internal docs');
        }
        if (ctx.flows) {
          pipelineState.addTask('flows', 'Modeling user flows');
          pipelineState.addTask('flow-doc', 'Narrating user-flow page');
        }
        pipelineState.addTask('internal-docs', 'Updating internal docs');
        if (ctx.enableRag) {
          pipelineState.addTask('rag-index-update', 'Updating RAG index');
        }
        pipelineState.addTask('doc-conflict-update', 'Detecting doc conflicts');
        pipelineState.addTask('review', 'Reviewing files');
        if (ctx.invariants) {
          pipelineState.addTask('invariants', 'Checking invariants');
        }
        if (ctx.deliberation) {
          pipelineState.addTask('refinement', 'Deliberation');
        }
        pipelineState.addTask('report', 'Generating report');
        ctx.pipelineState = pipelineState;

        const renderer = new ScreenRenderer(pipelineState, { plain: ctx.plain });
        ctx.renderer = renderer;
        renderer.start();

        // Background runs skip the global lock — they run in isolated worktrees
        // and use per-run status files for coordination (Story 47.6)
        if (!process.env.ANATOLY_BACKGROUND_MODE) {
          ctx.lockPath = acquireLock(projectRoot);
        }

        // --- Phase: bootstrap doc (first run only, skipped in quick-win) — Story 29.21 ---
        // Mode guards: `off` skips everything; `lite` defers doc context to
        // per-file RAG retrieval (no upfront digest, see `retrieveRelevantDocsForFile`);
        // `full` keeps the existing scaffold + generation + coherence + arbitration.
        // doc 14 PR 5: the run/skip decision is the centralized
        // `bootstrapDocGate` (gates.ts); the bodies/effects stay inline and
        // verbatim. Behaviorally byte-identical: same conditions, same
        // skip-reason strings, same order, same `!ctx.interrupted` guards.
        // doc-conflict detection's only scored output is the fold into the
        // correction axis (applyPendingConflictsToReviews). When a `--axes`
        // run excludes correction, that fold is skipped, so the (expensive,
        // abort-prone) detection has no scored destination this run — skip it
        // entirely. Already-arbitrated/pending conflicts are still loaded from
        // the store (loadArbitratedFragments / the report's markdown section),
        // so this only defers detection of NEW conflicts to a run that
        // includes correction. Unfiltered runs always run it.
        const docConflictInScope =
          !ctx.axesFilter || ctx.axesFilter.length === 0 || ctx.axesFilter.includes('correction');

        const bd = bootstrapDocGate(ctx, handoff);
        if (bd.run && !ctx.interrupted) {
          await runPhase(ctx, 'bootstrap-doc', async () => {
            await runDocBootstrap(ctx, handoff, setup.tasks);
          });
          // Mark the docs as validly scaffolded — the canonical signal
          // future `needsBootstrap()` checks will look for. Written after
          // runDocBootstrap returns (which itself includes the refinement
          // pass), so a crash mid-pipeline leaves no tag and the next run
          // correctly re-bootstraps.
          if (!ctx.interrupted) {
            writeScaffoldStatus(ctx.projectRoot, {
              mode: 'bootstrap',
              runId: ctx.runId,
            });
          }

          // Run doc-conflict detection after bootstrap — Story 55.4 FR5
          if (!ctx.interrupted && !docConflictInScope) {
            ctx.pipelineState?.completeTask('doc-conflict-bootstrap', 'skipped (correction not in --axes)');
          } else if (!ctx.interrupted) {
            const fragmentsDir = anatolyPath(ctx.projectRoot, 'state/internal-docs');
            await runPhase(ctx, 'doc-conflict-bootstrap', async () => {
              ctx.pipelineState?.startTask('doc-conflict-bootstrap', '…');
              let detail = 'failed';
              try {
                const dc = await runDocConflictDetection({
                  projectRoot: ctx.projectRoot,
                  config: ctx.config,
                  tasks: setup.tasks,
                  fragmentsDir,
                  runDir: ctx.runDir,
                  ...(ctx.router ? { router: ctx.router } : {}),
                });
                // doc 15 PR 1: fold the doc-conflict cost into the rollup
                // (the leak this contract closes; ledger already had it).
                if (dc.cost) recordDocConflictCost(ctx, 'doc-conflict-bootstrap', dc.cost);
                detail = formatDocConflictDetail(dc);
              } finally {
                ctx.pipelineState?.completeTask('doc-conflict-bootstrap', detail);
              }
            });
          }
        } else if (!bd.run && bd.reason === 'off' && !ctx.interrupted) {
          const log = getLogger();
          log.info('internal docs mode=off — skipping scaffold, generation, and coherence');
          ctx.renderer?.logPlain('[internal-docs] mode=off — skipping scaffold, generation, and coherence');
          ctx.pipelineState?.completeTask('bootstrap-doc', 'off');
        } else if (!bd.run && bd.reason === 'lite (per-file retrieval)' && !ctx.interrupted) {
          const log = getLogger();
          log.info('internal docs mode=lite — doc context delivered via per-file RAG retrieval (no digest)');
          ctx.renderer?.logPlain('[internal-docs] mode=lite — doc context delivered via per-file RAG retrieval');
          ctx.pipelineState?.completeTask('bootstrap-doc', 'lite (per-file retrieval)');
        }

        const ragContext = await runPhase(ctx, 'rag-index', async () => runRagPhase(ctx, handoff, setup.tasks));
        if (ctx.interrupted) return;

        // --- Phase: flows (doc 23, Stage 1, opt-in) ---
        // Deterministic, no-LLM walk that models user flows from the cards +
        // usage graph and writes the canonical state artifact. Runs right after
        // RAG (its only inputs are in memory by now) and emits zero scored
        // findings. No-op when disabled / RAG inactive.
        if (ctx.flows && !ctx.interrupted) {
          await runPhase(ctx, 'flows', async () => {
            await runFlowsPhase(ctx, handoff, ragContext);
          });
        }
        if (ctx.interrupted) return;

        // --- Phase: flow-doc (doc 23, Stage 2, opt-in) ---
        // Narrates the deterministic flow skeleton into the human-readable,
        // ratifiable user-flows.md page via the same agentic Read-only doc
        // writer as `anatoly docs` (no new transport). Internal-flows doc-source:
        // context-only, never project-scored, zero findings. No-op when disabled,
        // when the page already exists, or when no flows artifact was produced.
        if (ctx.flows && !ctx.interrupted) {
          await runPhase(ctx, 'flow-doc', async () => {
            await runFlowDocPhase(ctx);
          });
        }
        if (ctx.interrupted) return;

        // --- Phase: update internal docs (pre-review) — Story 55.2 ---
        // Moved from post-review to pre-review so that doc-conflict arbitration
        // results are available during the review phase of the current run.
        // Gate: triage-based (evaluable files exist) instead of filesReviewed > 0.
        // doc 14 PR 5: decision via the centralized `internalDocsGate`
        // (gates.ts; it computes hasEvaluableFiles from handoff.triageMap,
        // the identical ref to the pre-PR-4b setup.triageMap). Bodies and
        // effects stay inline and verbatim; behaviorally byte-identical.
        const id = internalDocsGate(ctx, handoff);
        if (id.run && !ctx.interrupted) {
          await runPhase(ctx, 'internal-docs', async () => {
            await runDocUpdate(ctx, handoff, setup.tasks);
          });

          // Re-index doc sections that changed after the doc-update pipeline.
          // Smart-chunk changed files (programmatic, 0 LLM cost) → pre-populate
          // chunk cache → restart embedding containers → re-embed + upsert → stop.
          // Now a named, observable phase (`rag-index-update`) so it shows in
          // the TUI / ndjson / `attach` like every other pipeline phase.
          if (ctx.enableRag && ctx.resolvedRagMode && ragContext.vectorStore) {
            const store = ragContext.vectorStore;
            await runPhase(ctx, 'rag-index-update', async () => {
              await reindexDocsAfterUpdate(ctx, handoff, store);
            });
          } else if (ctx.enableRag) {
            ctx.pipelineState?.completeTask('rag-index-update', 'skipped (rag inactive)');
          }

          // Refresh the pipeline-complete marker to record this update.
          if (!ctx.interrupted) {
            writeScaffoldStatus(ctx.projectRoot, {
              mode: 'update',
              runId: ctx.runId,
            });
          }

          // Run doc-conflict detection after update — Story 55.4 FR5
          if (!ctx.interrupted && !docConflictInScope) {
            ctx.pipelineState?.completeTask('doc-conflict-update', 'skipped (correction not in --axes)');
          } else if (!ctx.interrupted) {
            const fragmentsDir = anatolyPath(ctx.projectRoot, 'state/internal-docs');
            await runPhase(ctx, 'doc-conflict-update', async () => {
              ctx.pipelineState?.startTask('doc-conflict-update', '…');
              let detail = 'failed';
              try {
                const dc = await runDocConflictDetection({
                  projectRoot: ctx.projectRoot,
                  config: ctx.config,
                  tasks: setup.tasks,
                  fragmentsDir,
                  runDir: ctx.runDir,
                  ...(ctx.router ? { router: ctx.router } : {}),
                  // doc 16 PR 2b: reuse the already-populated store for the
                  // cosine pair match (internal side not re-embedded).
                  ...(ragContext.vectorStore ? { vectorStore: ragContext.vectorStore } : {}),
                });
                // doc 15 PR 1: fold the doc-conflict cost into the rollup
                // (the leak this contract closes; ledger already had it).
                if (dc.cost) recordDocConflictCost(ctx, 'doc-conflict-update', dc.cost);
                detail = formatDocConflictDetail(dc);
              } finally {
                ctx.pipelineState?.completeTask('doc-conflict-update', detail);
              }
            });
          }
        } else if (!id.run && id.reason === 'off' && !ctx.interrupted) {
          ctx.pipelineState?.completeTask('internal-docs', 'off');
          if (ctx.enableRag) ctx.pipelineState?.completeTask('rag-index-update', 'skipped (docs off)');
          ctx.pipelineState?.completeTask('doc-conflict-update', 'skipped (docs off)');
        } else if (!id.run && id.reason === 'lite (per-file retrieval)' && !ctx.interrupted) {
          // Lite mode no longer materialises an internal-docs artefact at
          // run scope. Reference content reaches the axes per file via RAG
          // retrieval (see file-evaluator → retrieveRelevantDocsForFile).
          ctx.pipelineState?.completeTask('internal-docs', 'lite (per-file retrieval)');
          if (ctx.enableRag) ctx.pipelineState?.completeTask('rag-index-update', 'skipped (lite)');
          ctx.pipelineState?.completeTask('doc-conflict-update', 'skipped (lite)');
        } else if (!id.run && id.reason === 'skipped — no evaluable files' && !ctx.interrupted) {
          ctx.pipelineState?.completeTask('internal-docs', 'skipped — no evaluable files');
          if (ctx.enableRag) ctx.pipelineState?.completeTask('rag-index-update', 'skipped — no evaluable files');
          ctx.pipelineState?.completeTask('doc-conflict-update', 'skipped — no evaluable files');
        }
        // Story 55.7: load doc-wins arbitrated fragments for axis prompts
        if (!ctx.interrupted) {
          handoff.arbitratedFragments = loadArbitratedFragments(ctx.projectRoot);
        }

        if (ctx.interrupted) return;

        // --- Phase: review (pass 1) ---
        await runPhase(ctx, 'review', async () => {
          await runReviewPhase(ctx, handoff, ragContext);
        });
        if (ctx.interrupted) {
          emitInterruptSummary(ctx, handoff);
          return;
        }

        // --- Phase: invariants (pre-deliberation, opt-in) ---
        // Runs the structural matcher + adversarial judge over the reviews the
        // axes produced, writing confirmed inter-representation findings onto
        // SymbolReview.invariant_findings so deliberation (tier 2) and the
        // report fold pick them up. No-op when disabled / RAG inactive.
        if (ctx.invariants && !ctx.interrupted) {
          await runPhase(ctx, 'invariants', async () => {
            await runInvariantsPhase(ctx, handoff, ragContext);
          });
        }
        if (ctx.interrupted) {
          emitInterruptSummary(ctx, handoff);
          return;
        }

        // --- Phase: refinement (tier 1 → tier 2 → tier 3) — Story 41.5 ---
        // doc 14 PR 5: decision via the centralized `refinementGate`
        // (gates.ts); body inline and verbatim, behaviorally byte-identical.
        const rf = refinementGate(ctx, handoff);
        if (rf.run && !ctx.interrupted) {
          await runPhase(ctx, 'refinement', () => runRefinementStage(ctx, handoff, setup));
        } else if (!rf.run && rf.reason === 'skipped — deliberation disabled' && !ctx.interrupted) {
          ctx.pipelineState?.completeTask('refinement', 'skipped — deliberation disabled');
        }

        if (ctx.interrupted) {
          emitInterruptSummary(ctx, handoff);
          return;
        }

        await runPhase(ctx, 'report', async () => { runReportPhase(ctx, handoff); });

        // Desktop notification for background runs (Story 47.5)
        if (process.env.ANATOLY_BACKGROUND_MODE && cmdOpts.notify !== false) {
          sendDesktopNotification(
            'Anatoly',
            `Review complete — ${handoff.totalFindings} finding${handoff.totalFindings !== 1 ? 's' : ''} in ${handoff.totalFiles} file${handoff.totalFiles !== 1 ? 's' : ''}`,
          );
        }

        if (ctx.lockPath) releaseLock(ctx.lockPath);
        ctx.lockPath = undefined;
        });
}
