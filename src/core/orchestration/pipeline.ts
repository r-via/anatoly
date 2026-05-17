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
 * then pruned. PR 8c replaces the §4 ctx-mutation handoff with the typed
 * handoff object; this PR is move-only.
 */

import { join } from 'node:path';
import { createHandoff } from './handoff.js';
import type { ResolvedModels } from '../../rag/hardware-detect.js';
import { acquireLock, releaseLock } from '../../utils/lock.js';
import { sendDesktopNotification } from '../notifications/desktop.js';
import { getLogger } from '../../utils/logger.js';
import { enterLlmCallSink } from '../../utils/llm-calls-sink.js';
import { runWithContext } from '../../utils/log-context.js';
import { isDocAxisActive } from '../axes/index.js';
import { formatRunDuration } from '../../utils/format.js';
import { PipelineState } from '../../cli/pipeline-state.js';
import { ScreenRenderer } from '../../cli/screen-renderer.js';
import { resolveDocMode } from '../run-config.js';
import { needsBootstrap, writeScaffoldStatus } from '../doc-bootstrap.js';
import { anatolyPath } from '../../utils/anatoly-paths.js';
import { runDocConflictDetection } from '../doc-conflict-detector.js';
import { runPhase } from './run-phase.js';
import { runReportPhase } from './phases/report.js';
import { runSetupPhase } from './phases/setup.js';
import { runRagPhase } from './phases/rag.js';
import { runDocBootstrap, runDocUpdate, reindexDocsAfterUpdate } from './phases/doc.js';
import { runRefinementStage } from './phases/refinement.js';
import { runReviewPhase } from './phases/review.js';
import { loadDocConflicts } from '../doc-conflict-store.js';
import type { ArbitratedFragment } from '../axes/reference-docs-context.js';
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
        enterLlmCallSink(join(ctx.runDir, 'costs', 'ledger.ndjson'));

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
        }
        if (ctx.enableRag) {
          pipelineState.addTask('rag-code', 'Embedding code');
          pipelineState.addTask('rag-nlp', 'LLM summaries & embedding');
          pipelineState.addTask('rag-doc-project', 'Chunking & embedding project docs');
          pipelineState.addTask('rag-doc-internal', 'Chunking & embedding internal docs');
        }
        pipelineState.addTask('internal-docs', 'Updating internal docs');
        pipelineState.addTask('review', 'Reviewing files');
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
        const internalDocMode = resolveDocMode(ctx.config);
        if (internalDocMode === 'off' && !ctx.interrupted) {
          const log = getLogger();
          log.info('internal docs mode=off — skipping scaffold, generation, and coherence');
          ctx.renderer?.logPlain('[internal-docs] mode=off — skipping scaffold, generation, and coherence');
          ctx.pipelineState?.completeTask('bootstrap-doc', 'off');
        } else if (internalDocMode === 'lite' && !ctx.interrupted) {
          const log = getLogger();
          log.info('internal docs mode=lite — doc context delivered via per-file RAG retrieval (no digest)');
          ctx.renderer?.logPlain('[internal-docs] mode=lite — doc context delivered via per-file RAG retrieval');
          ctx.pipelineState?.completeTask('bootstrap-doc', 'lite (per-file retrieval)');
        } else if (handoff.isFirstRun && isDocAxisActive(ctx) && !ctx.interrupted) {
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
          if (!ctx.interrupted) {
            const fragmentsDir = anatolyPath(ctx.projectRoot, 'state/internal-docs');
            await runPhase(ctx, 'doc-conflict-bootstrap', async () => {
              await runDocConflictDetection({
                projectRoot: ctx.projectRoot,
                config: ctx.config,
                tasks: setup.tasks,
                fragmentsDir,
                runDir: ctx.runDir,
                ...(ctx.router ? { router: ctx.router } : {}),
              });
            });
          }
        }

        const ragContext = await runPhase(ctx, 'rag-index', async () => runRagPhase(ctx, handoff, setup.tasks));
        if (ctx.interrupted) return;

        // --- Phase: update internal docs (pre-review) — Story 55.2 ---
        // Moved from post-review to pre-review so that doc-conflict arbitration
        // results are available during the review phase of the current run.
        // Gate: triage-based (evaluable files exist) instead of filesReviewed > 0.
        const hasEvaluableFiles = [...setup.triageMap.values()].some(t => t.tier === 'evaluate');
        if (internalDocMode === 'off' && !ctx.interrupted) {
          ctx.pipelineState?.completeTask('internal-docs', 'off');
        } else if (internalDocMode === 'lite' && !ctx.interrupted) {
          // Lite mode no longer materialises an internal-docs artefact at
          // run scope. Reference content reaches the axes per file via RAG
          // retrieval (see file-evaluator → retrieveRelevantDocsForFile).
          ctx.pipelineState?.completeTask('internal-docs', 'lite (per-file retrieval)');
        } else if (internalDocMode !== 'lite' && internalDocMode !== 'off' && !ctx.interrupted && hasEvaluableFiles) {
          await runPhase(ctx, 'internal-docs', async () => {
            await runDocUpdate(ctx, handoff, setup.tasks);
          });

          // Re-index doc sections that changed after the doc-update pipeline.
          // Smart-chunk changed files (programmatic, 0 LLM cost) → pre-populate
          // chunk cache → restart embedding containers → re-embed + upsert → stop.
          if (ctx.enableRag && ctx.resolvedRagMode && ragContext.vectorStore) {
            await reindexDocsAfterUpdate(ctx, handoff, ragContext.vectorStore);
          }

          // Refresh the pipeline-complete marker to record this update.
          if (!ctx.interrupted) {
            writeScaffoldStatus(ctx.projectRoot, {
              mode: 'update',
              runId: ctx.runId,
            });
          }

          // Run doc-conflict detection after update — Story 55.4 FR5
          if (!ctx.interrupted) {
            const fragmentsDir = anatolyPath(ctx.projectRoot, 'state/internal-docs');
            await runPhase(ctx, 'doc-conflict-update', async () => {
              await runDocConflictDetection({
                projectRoot: ctx.projectRoot,
                config: ctx.config,
                tasks: setup.tasks,
                fragmentsDir,
                runDir: ctx.runDir,
                ...(ctx.router ? { router: ctx.router } : {}),
              });
            });
          }
        } else if (!ctx.interrupted) {
          ctx.pipelineState?.completeTask('internal-docs', 'skipped — no evaluable files');
        }
        // Story 55.7: load doc-wins arbitrated fragments for axis prompts
        if (!ctx.interrupted) {
          handoff.arbitratedFragments = loadArbitratedFragments(ctx.projectRoot);
        }

        if (ctx.interrupted) return;

        // --- Phase: review (pass 1) ---
        await runPhase(ctx, 'review', async () => {
          await runReviewPhase(ctx, handoff, setup.triageMap, setup.usageGraph, ragContext, setup.depMeta, setup.projectTree, setup.docsTree, setup.internalDocsTree, setup.internalDocsDir);
        });
        if (ctx.interrupted) {
          const inFlight = ctx.activeAborts.size;
          const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
          console.log(`interrupted — ${handoff.filesReviewed}/${handoff.totalFiles} files reviewed | ${handoff.totalFindings} findings${inFlightNote} | ${formatRunDuration(Date.now() - ctx.startTime)}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          ctx.lockPath = undefined;
          return;
        }

        // --- Phase: refinement (tier 1 → tier 2 → tier 3) — Story 41.5 ---
        if (ctx.deliberation && handoff.filesReviewed > 0 && !ctx.interrupted) {
          await runPhase(ctx, 'refinement', () => runRefinementStage(ctx, handoff, setup));
        } else if (!ctx.interrupted && handoff.filesReviewed > 0) {
          ctx.pipelineState?.completeTask('refinement', 'skipped — deliberation disabled');
        }

        if (ctx.interrupted) {
          const inFlight = ctx.activeAborts.size;
          const inFlightNote = inFlight > 0 ? ` (${inFlight} in-flight aborted)` : '';
          console.log(`interrupted — ${handoff.filesReviewed}/${handoff.totalFiles} files reviewed | ${handoff.totalFindings} findings${inFlightNote} | ${formatRunDuration(Date.now() - ctx.startTime)}`);
          if (ctx.lockPath) releaseLock(ctx.lockPath);
          ctx.lockPath = undefined;
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
