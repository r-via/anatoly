// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Doc phases (extracted from run.ts in PR 5, doc 11 Strategy B).
 *
 * Move-only: the block below is verbatim run.ts (the doc-section banner,
 * runDocLlmPhase, runDocBootstrap, runDocUpdate, reindexDocsAfterUpdate,
 * with their JSDocs). Forced edits only: `export` on the three spine-called
 * functions (runDocLlmPhase stays module-private; the spine never calls it).
 * No inline imports in these bodies. The spine still drives them via the
 * unchanged runPhase('bootstrap-doc'|'internal-docs') gates and the
 * reindexDocsAfterUpdate call.
 *
 * All four return Promise<void>. recordLlmCost and requestFatalStop come
 * from their relocated homes; RunContext is type-only (erased). Import
 * list seeded from run.ts (path-rewritten) then pruned.
 *
 * Post-PR-8 state (doc 11): the orchestration spine lives in
 * pipeline.ts (PR 8a), not run.ts; this phase receives the typed
 * `Handoff` object explicitly as a parameter (PR 8c) and the §4
 * inter-phase data is no longer `ctx` mutation. Any line above
 * describing a run.ts call site, `ctx`-mutation, or "handoff
 * untouched until PR 8" is extraction-era history, superseded here.
 */

import { readFileSync } from 'node:fs';
import type { Handoff } from '../handoff.js';
import { resolve, join } from 'node:path';
import { getDocsDir } from '../../../schemas/config.js';
import { isFatalAuthError, isAuthFailureMessage, authError } from '../../../utils/errors.js';
import { smartChunkAndCache, indexDocSections } from '../../../rag/index.js';
import { startGgufContainers, stopGgufContainers } from '../../../rag/docker-gguf.js';
import { getLogger } from '../../../utils/logger.js';
import { runWithContext } from '../../../utils/log-context.js';
import { retryWithBackoff } from '../../../utils/rate-limiter.js';
import { withTimeout } from '../../../utils/with-timeout.js';
import type { Task } from '../../../schemas/task.js';
import type { VectorStore } from '../../../rag/vector-store.js';
import { runDocScaffold, runDocGeneration, commitDocPage } from '../../documentation/index.js';
import { autoFixStructuralIssues, executeDocPrompts, reviewDocStructure, runDocCoherenceReview, type DocExecutor } from '../../documentation/index.js';
import { writeCoherenceStatus, computeDocSetSignature, coherenceUpToDate } from '../../documentation/index.js';
import { getEffectiveSourceRoot } from '../../worktree/index.js';
import { runPath } from '../../../utils/anatoly-paths.js';
import { buildCodeSurfaceSummary } from '../../documentation/index.js';
import { recordLlmCost } from '../cost.js';
import { requestFatalStop } from '../run-control.js';
import type { RunContext } from '../../../commands/run.js';

// ---------------------------------------------------------------------------
// Doc generation (LLM) — Story 29.17
// ---------------------------------------------------------------------------

async function runDocLlmPhase(ctx: RunContext, handoff: Handoff, taskId = 'doc-gen'): Promise<void> {
  const genResult = handoff.docPipelineResult?.generation;
  if (!genResult || genResult.prompts.length === 0) return;

  const log = getLogger();
  const outputDir = handoff.docPipelineResult!.scaffold.outputDir;
  const total = genResult.prompts.length;
  const ac = new AbortController();
  ctx.activeAborts.add(ac);

  const startDetail = taskId === 'bootstrap-doc' ? 'Creating internal documentation...' : `0/${total}`;
  ctx.pipelineState?.startTask(taskId, startDetail);

  const phaseStart = Date.now();
  const timeoutMs = ctx.config.runtime.timeout_per_file * 1000;
  let completed = 0;
  const executor: DocExecutor = async ({ system, user, model }) => {
    // Concurrency is owned by executeDocPrompts/executeOnePage, which already
    // holds a router slot for this page. Routing through router.agenticQuery()
    // would acquire a *second* slot on the same per-provider semaphore and
    // deadlock the whole bootstrap once pages >= provider concurrency (Story
    // 46.5 regression). Resolve the transport directly — same contract as
    // pipeline-runner's createExecutor — and own the retry here.
    const transport = ctx.router!.resolve(model, 'agents');
    if (!transport.agenticQuery) {
      throw new Error(`Transport '${transport.provider}' does not support agentic queries`);
    }
    // Per-page abort + wall-clock budget: the SDK loop has no internal timeout,
    // so without this a single stuck page hangs the whole Promise.allSettled.
    // Registered in activeAborts so SIGINT cancels it too. The shared phase
    // `ac` stays reserved for the coherence pass below.
    const pageAc = new AbortController();
    ctx.activeAborts.add(pageAc);
    try {
      const response = await withTimeout(
        () => retryWithBackoff(
          () => transport.agenticQuery!({
            systemPrompt: system,
            userMessage: user,
            model,
            projectRoot: ctx.projectRoot,
            abortController: pageAc,
            allowedTools: ['Read'],
            maxTurns: ctx.config.agents.max_turns,
            config: ctx.config,
            conversationDir: join(ctx.runDir, 'conversations'),
            conversationPrefix: `doc-gen-${Date.now()}`,
            attempt: 1,
          }),
          {
            maxRetries: 5,
            baseDelayMs: 5_000,
            maxDelayMs: 60_000,
            jitterFactor: 0.2,
            filePath: 'doc-gen',
            isInterrupted: () => ctx.interrupted || pageAc.signal.aborted,
            onRetry: (attempt, delayMs) =>
              getLogger().warn({ attempt, delayMs }, 'doc generation retrying'),
          },
        ),
        {
          timeoutMs,
          label: 'doc page generation',
          onTimeout: () => pageAc.abort(),
        },
      );
      return { text: response.text, costUsd: response.costUsd };
    } finally {
      ctx.activeAborts.delete(pageAc);
    }
  };

  try {
    const result = await executeDocPrompts({
      prompts: genResult.prompts,
      outputDir,
      projectRoot: ctx.projectRoot,
      router: ctx.router,
      executor,
      logDir: join(ctx.runDir, 'conversations'),
      onPageStart: (pagePath) => {
        ctx.pipelineState?.trackFile(pagePath);
      },
      onPageComplete: (pagePath) => {
        completed++;
        // Per-page completion flag: the page is now written to disk, so
        // record its source hashes immediately — before coherence. A crash
        // or interrupt after this point leaves this page cached (skipped
        // next run) while still-stub pages stay uncached (regenerated).
        commitDocPage(genResult.cachePath, pagePath, genResult.pageHashes[pagePath] ?? {});
        ctx.pipelineState?.untrackFile(pagePath);
        ctx.pipelineState?.updateTask(taskId, `${completed}/${total} pages updated`);
        ctx.renderer?.logPlain(`[${taskId}] ${completed}/${total} ${pagePath}`);
      },
      onPageError: (pagePath, err) => {
        ctx.pipelineState?.untrackFile(pagePath);
        // A provider-auth failure is run-fatal: stop now instead of letting
        // every remaining page fail and the run limp to `done`.
        if (isFatalAuthError(err) || isAuthFailureMessage(err.message)) {
          requestFatalStop(ctx, isFatalAuthError(err) ? err : authError('anthropic'));
          return;
        }
        log.warn({ pagePath, err: err.message }, 'doc generation failed for page');
      },
    });

    // Safety net: if any page failed with an auth error but the typed error
    // was flattened to a string in result.errors, still stop the run.
    if (!ctx.fatalError && result.errors.some(e => isAuthFailureMessage(e.error))) {
      requestFatalStop(ctx, authError('anthropic'));
    }

    // Aggregate doc generation LLM costs. Per-call tokens aren't surfaced
    // by `executeDocPrompts` — they remain visible in `costs/ledger.ndjson`.
    recordLlmCost(ctx, {
      provider: 'anthropic',
      phase: taskId,
      costUsd: result.totalCostUsd,
      durationMs: Date.now() - phaseStart,
      calls: result.pagesWritten + result.pagesFailed,
    });

    log.info({ pagesWritten: result.pagesWritten, pagesFailed: result.pagesFailed, costUsd: result.totalCostUsd }, 'doc generation complete');

    // Structure lint — deterministic preamble/fence cleanup
    const docsPath = getDocsDir(ctx.config);
    if (result.pagesWritten > 0 && !ctx.interrupted) {
      ctx.pipelineState?.updateTask(taskId, 'linting docs…');
      ctx.renderer?.logPlain(`[${taskId}] linting doc structure…`);
      try {
        const lintLogDir = runPath(ctx.projectRoot, ctx.runId, 'structure-review');
        const lintResult = reviewDocStructure(outputDir, ctx.projectRoot, docsPath, undefined, { logDir: lintLogDir });
        log.info({ filesFixed: lintResult.filesFixed, issues: lintResult.issues.length }, 'doc structure lint complete');
        ctx.renderer?.logPlain(`[${taskId}] structure lint: ${lintResult.issues.length} issues, ${lintResult.filesFixed} auto-fixed`);

        // Auto-fix structural issues (numbering, index) before coherence review
        const unfixed = lintResult.issues.filter(i => !i.fixed);
        if (unfixed.length > 0) {
          ctx.pipelineState?.updateTask(taskId, 'fixing doc structure…');
          ctx.renderer?.logPlain(`[${taskId}] fixing ${unfixed.length} structural issues…`);
          const fixResult = autoFixStructuralIssues(outputDir, unfixed);
          log.info({
            renames: fixResult.renames.length,
            indexAdded: fixResult.indexEntriesAdded.length,
            orphansRemoved: fixResult.indexOrphansRemoved.length,
            linksUpdated: fixResult.linksUpdated,
          }, 'doc auto-fix complete');
        }
      } catch (lintErr) {
        log.warn({ err: lintErr }, 'doc structure lint/auto-fix failed — continuing');
      }
    }

    // Coherence review — only on first run (bootstrap). Use `anatoly docs coherence` for on-demand.
    // Skip when the coherence agent already flagged this exact doc set: a
    // retry must not redo a coherence pass whose inputs are byte-identical.
    //
    // Narrow by design: it only triggers when pages were (re)written
    // (pagesWritten > 0 — else coherence is skipped anyway) yet the resulting
    // doc set is byte-for-byte what coherence last reviewed. In practice that
    // is the resume case where generation produced no net change (cache hits
    // re-confirmed) but a previous run never reached writeScaffoldStatus. Any
    // genuinely regenerated page changes the signature and re-runs coherence.
    if (
      result.pagesWritten > 0 &&
      !ctx.interrupted &&
      taskId === 'bootstrap-doc' &&
      coherenceUpToDate(ctx.projectRoot, outputDir)
    ) {
      log.info('doc coherence review skipped — doc set unchanged since last pass');
      ctx.renderer?.logPlain(`[${taskId}] coherence review skipped — docs unchanged since last pass`);
    } else if (result.pagesWritten > 0 && !ctx.interrupted && taskId === 'bootstrap-doc') {
      ctx.pipelineState?.updateTask(taskId, 'coherence review (Sonnet)…');
      ctx.renderer?.logPlain(`[${taskId}] coherence review (Sonnet) — reviewing ${result.pagesWritten} pages…`);
      const coherenceStart = Date.now();
      try {
        const coherenceLogDir = runPath(ctx.projectRoot, ctx.runId, 'coherence-review');
        // Switch the phase tag for the duration of the coherence pass so
        // its llm_call event lands under `phase: "coherence-review"` in
        // the ndjson — the surrounding block is `bootstrap-doc`, which
        // would otherwise absorb its tokens.
        const coherenceResult = await runWithContext({ phase: 'coherence-review' }, async () =>
          runDocCoherenceReview({
            outputDir,
            projectRoot: ctx.projectRoot,
            docsPath,
            abortController: ac,
            logDir: coherenceLogDir,
            router: ctx.router,
            timeoutMs,
            codeSurface: buildCodeSurfaceSummary(handoff.allTasks),
            callbacks: {
              onToolUse: (_tool, filePath) => {
                const name = filePath.split('/').pop() ?? filePath;
                ctx.pipelineState?.updateTask(taskId, `reviewing ${name}…`);
              },
            },
          }),
        );
        recordLlmCost(ctx, {
          provider: 'anthropic',
          phase: 'coherence-review',
          costUsd: coherenceResult.costUsd,
          durationMs: Date.now() - coherenceStart,
        });
        log.info({
          issuesBefore: coherenceResult.linterIssuesBefore,
          issuesAfter: coherenceResult.linterIssuesAfter,
          costUsd: coherenceResult.costUsd,
        }, 'doc coherence review complete');
        ctx.renderer?.logPlain(`[${taskId}] coherence review done — ${coherenceResult.linterIssuesBefore} issues before, ${coherenceResult.linterIssuesAfter} after ($${coherenceResult.costUsd.toFixed(4)})`);
        // The coherence agent flags its own completion, keyed to the exact
        // doc set it just reviewed (post-fixes). A later retry with an
        // identical set skips this pass entirely (see coherenceUpToDate).
        writeCoherenceStatus(ctx.projectRoot, computeDocSetSignature(outputDir));
      } catch (coherenceErr) {
        if (isFatalAuthError(coherenceErr)) {
          requestFatalStop(ctx, coherenceErr);
          return;
        }
        log.warn({ err: coherenceErr }, 'doc coherence review failed — continuing');
        ctx.renderer?.logPlain(`[${taskId}] coherence review failed — continuing`);
      }
    }

    const detail = result.pagesFailed > 0
      ? `${result.pagesWritten}/${total} written · ${result.pagesFailed} failed`
      : `${result.pagesWritten}/${total} pages`;
    ctx.pipelineState?.completeTask(taskId, detail);
  } finally {
    ctx.activeAborts.delete(ac);
  }
}

/**
 * Bootstrap internal docs: scaffold structure + generate all pages.
 * Only runs on first run (no .anatoly/docs/ yet). Story 29.21.
 * Errors are caught and logged as warnings (non-fatal).
 *
 * @param ctx Run context providing projectRoot, config, and SDK semaphore.
 * @param tasks Scanned task list for doc-generator context.
 */
export async function runDocBootstrap(ctx: RunContext, handoff: Handoff, tasks: Task[]): Promise<void> {
  const taskId = 'bootstrap-doc';
  const log = getLogger();
  const rl = ctx.runLog;
  const srcRoot = getEffectiveSourceRoot(ctx.projectRoot, ctx.sourceRoot);

  try {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(readFileSync(resolve(srcRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
    } catch { /* no package.json — non-JS project */ }
    const docsPath = getDocsDir(ctx.config);

    // Scaffold + generate (first time)
    ctx.renderer?.logPlain(`[${taskId}] scaffolding & generating internal documentation...`);
    if (!ctx.profile) throw new Error('project profile not detected — cannot run doc pipeline');
    const scaffoldResult = runDocScaffold(ctx.projectRoot, pkg, tasks, docsPath, ctx.profile);
    const genResult = runDocGeneration(ctx.projectRoot, scaffoldResult, tasks, pkg);
    handoff.docPipelineResult = { scaffold: scaffoldResult, generation: genResult };

    log.info({
      phase: taskId,
      pagesCreated: scaffoldResult.scaffoldResult.pagesCreated.length,
      prompts: genResult.prompts.length,
      fresh: genResult.cacheResult.fresh.length,
    }, `${taskId} scaffold complete`);
    rl?.info({
      phase: taskId,
      pagesCreated: scaffoldResult.scaffoldResult.pagesCreated.length,
      prompts: genResult.prompts.length,
    }, `${taskId} scaffold complete`);

    if (genResult.prompts.length > 0 && !ctx.interrupted) {
      await runDocLlmPhase(ctx, handoff, taskId);
    } else {
      ctx.pipelineState?.completeTask(taskId, 'all cached');
    }
  } catch (err) {
    if (isFatalAuthError(err)) {
      requestFatalStop(ctx, err);
      return;
    }
    log.warn({ err }, `${taskId} failed — continuing`);
    rl?.warn({ err }, `${taskId} failed`);
  }
}

/**
 * Update internal docs: regenerate only pages whose source code changed.
 * No scaffold — uses existing structure. Runs every run post-review. Story 29.21.
 * Falls back gracefully when no prompts are generated.
 *
 * @param ctx Run context providing projectRoot, config, and SDK semaphore.
 * @param tasks Scanned task list for doc-generator context.
 */
export async function runDocUpdate(ctx: RunContext, handoff: Handoff, tasks: Task[]): Promise<void> {
  const taskId = 'internal-docs';
  const log = getLogger();
  const rl = ctx.runLog;

  try {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(readFileSync(resolve(getEffectiveSourceRoot(ctx.projectRoot, ctx.sourceRoot), 'package.json'), 'utf-8')) as Record<string, unknown>;
    } catch { /* no package.json — non-JS project */ }
    const docsPath = getDocsDir(ctx.config);

    // Scaffold only for new modules (idempotent, skips existing pages)
    if (!ctx.profile) throw new Error('project profile not detected — cannot run doc pipeline');
    const scaffoldResult = runDocScaffold(ctx.projectRoot, pkg, tasks, docsPath, ctx.profile);
    const newPages = scaffoldResult.scaffoldResult.pagesCreated.length;

    // Scope doc updates to modules whose source files were actually reviewed.
    // Files with tier 'evaluate' in the triageMap are the ones that changed.
    const changedFiles = new Set<string>();
    for (const [file, triage] of handoff.triageMap) {
      if (triage.tier === 'evaluate') changedFiles.add(file);
    }

    // Generate only stale/new pages whose modules were touched (cache-aware)
    const genResult = runDocGeneration(ctx.projectRoot, scaffoldResult, tasks, pkg, changedFiles);
    handoff.docPipelineResult = { scaffold: scaffoldResult, generation: genResult };

    const deferredNote = genResult.pagesDeferred > 0 ? `, ${genResult.pagesDeferred} deferred` : '';
    ctx.renderer?.logPlain(`[${taskId}] ${newPages > 0 ? `${newPages} new pages, ` : ''}${genResult.prompts.length} to update, ${genResult.cacheResult.fresh.length} cached${deferredNote}`);

    log.info({
      phase: taskId,
      newPages,
      prompts: genResult.prompts.length,
      fresh: genResult.cacheResult.fresh.length,
      deferred: genResult.pagesDeferred,
    }, `${taskId} ready`);

    if (genResult.prompts.length > 0 && !ctx.interrupted) {
      await runDocLlmPhase(ctx, handoff, taskId);
    } else {
      ctx.pipelineState?.completeTask(taskId, 'all cached');
    }
  } catch (err) {
    log.warn({ err }, `${taskId} failed — continuing`);
    rl?.warn({ err }, `${taskId} failed`);
    ctx.pipelineState?.completeTask(taskId, 'failed');
  }

}

/**
 * Re-index doc sections after the doc-update pipeline has modified `.anatoly/docs/`.
 *
 * 1. Smart-chunk changed files (programmatic, 0 LLM cost) → pre-populate chunk cache.
 * 2. For advanced mode, briefly restart GGUF containers for NLP embedding.
 * 3. Call `indexDocSections` which finds chunk-cache hits → skips Haiku → only embeds + upserts.
 * 4. Stop containers.
 */
export async function reindexDocsAfterUpdate(ctx: RunContext, handoff: Handoff, vectorStore: VectorStore): Promise<void> {
  const log = getLogger();
  const cacheSuffix = ctx.resolvedRagMode!; // 'lite' | 'advanced' | 'external'
  const internalDocsDir = join('.anatoly', 'state', 'internal-docs');
  const docsDir = getDocsDir(ctx.config);

  // Phase 1: smart-chunk changed files into chunk cache (pure computation, no LLM)
  const intChunked = smartChunkAndCache(ctx.projectRoot, internalDocsDir, `${cacheSuffix}-internal`);
  // Skip project docs when dedup mode — the alias in the vector store maps internal → project.
  const projChunked = ctx.docsIdentical ? 0 : smartChunkAndCache(ctx.projectRoot, docsDir, cacheSuffix);

  if (intChunked + projChunked === 0) return; // nothing changed

  ctx.renderer?.logPlain(`[rag] smart-chunked ${intChunked} internal${projChunked > 0 ? ` + ${projChunked} project` : ''} doc files`);

  // Phase 2: restart embedding containers if advanced mode
  const logFn = ctx.verbose ? (msg: string) => { log.debug(msg); } : undefined;
  let containersStarted = false;
  if (ctx.resolvedRagMode === 'advanced') {
    containersStarted = await startGgufContainers(ctx.projectRoot, logFn);
    if (!containersStarted) {
      log.warn('GGUF containers failed to restart for doc re-indexing — docs will be re-indexed on next run');
      return;
    }
    ctx.renderer?.logPlain('[rag] GGUF containers restarted for doc re-indexing');
  }

  // Phase 3: re-index changed docs (chunk cache hit → no Haiku, just embed + upsert)
  try {
    const onLog = (msg: string) => {
      ctx.runLog?.debug({ phase: 'rag-doc-reindex' }, msg);
      ctx.renderer?.logPlain(`[rag] ${msg}`);
    };

    if (intChunked > 0) {
      const intResult = await indexDocSections({
        projectRoot: ctx.projectRoot,
        vectorStore,
        docsDir: internalDocsDir,
        cacheSuffix: `${cacheSuffix}-internal`,
        chunkModel: ctx.config.models.fast,
        onLog,
        isInterrupted: () => ctx.interrupted,
        conversationDir: join(ctx.runDir, 'conversations'),
        router: ctx.router,
        docSource: 'internal',
      });
      onLog(`doc re-index (internal): ${intResult.sections} sections, $${intResult.costUsd.toFixed(4)}`);
    }

    if (projChunked > 0) {
      const projResult = await indexDocSections({
        projectRoot: ctx.projectRoot,
        vectorStore,
        docsDir,
        cacheSuffix,
        chunkModel: ctx.config.models.fast,
        onLog,
        isInterrupted: () => ctx.interrupted,
        conversationDir: join(ctx.runDir, 'conversations'),
        router: ctx.router,
        docSource: 'project',
      });
      onLog(`doc re-index (project): ${projResult.sections} sections, $${projResult.costUsd.toFixed(4)}`);
    }
  } finally {
    // Phase 4: stop containers
    if (containersStarted) {
      await stopGgufContainers(logFn);
      ctx.renderer?.logPlain('[rag] GGUF containers stopped after doc re-indexing');
    }
  }
}
