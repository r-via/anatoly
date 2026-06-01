// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync, cpSync, lstatSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import chalk from 'chalk';
import { anatolyPath, commandPath } from '../utils/anatoly-paths.js';
import { pruneTimestampedRuns } from '../utils/command-retention.js';
import { isLockActive } from '../utils/lock.js';
import { loadConfig } from '../utils/config-loader.js';
import { getDocsDir } from '../schemas/config.js';
import { scanProject } from '../core/scanning/index.js';
import { loadTasks } from '../core/run/index.js';
import { runDocScaffold, runDocGeneration, commitDocPage } from '../core/documentation/index.js';
import { executeDocPrompts, reviewDocStructure, runDocCoherenceReview, autoFixStructuralIssues } from '../core/documentation/index.js';
import { runPipeline } from '../cli/pipeline-runner.js';
import { indexProjectStandalone, resolveRagTableName } from '../rag/standalone.js';
import { detectDocGapsV2, formatGapReportV2 } from '../core/documentation/index.js';
import { VectorStore } from '../rag/vector-store.js';
import { resolveSystemPrompt } from '../core/platform/index.js';
import { areDocTreesIdentical } from '../rag/doc-indexer.js';
import { runArbitrateWizard, runRefreshStandalone, type RefreshFn } from './docs-arbitrate.js';
import { refreshPendingConflicts } from '../core/documentation/index.js';
import { TransportRouter, type ProviderModeConfig, type LlmTransport } from '../core/transports/index.js';
import { AnthropicTransport } from '../core/transports/anthropic-transport.js';
import { VercelSdkTransport } from '../core/transports/vercel-sdk-transport.js';
import type { Config } from '../schemas/config.js';

// --- Shared: RAG-driven update + lint + coherence ---

import type { PipelineContext } from '../cli/pipeline-runner.js';

async function runDocUpdate(
  ctx: PipelineContext,
  outputDir: string,
  updateTaskId: string,
  coherenceTaskId: string,
): Promise<void> {
  ctx.state.startTask(updateTaskId, 'gap detection…');

  const tableName = resolveRagTableName(ctx.projectRoot);
  const store = new VectorStore(ctx.projectRoot, tableName);
  await store.init();

  const gapReport = await detectDocGapsV2(store, {
    scope: 'internal',
    onProgress: (phase, current, total) => {
      ctx.state.updateTask(updateTaskId, `${phase}: ${current}/${total}…`);
    },
  });

  // Collect all pages that need work, merging two gap kinds onto the same
  // page entry so a single Sonnet pass per page handles both: missing
  // functions (per-domain) and missing concepts (routed by suggestedPage).
  // The previous design ran a second Opus `runDocContentReview` after this
  // loop just to attach concept paragraphs — but the loop already owns
  // page-level edits, so folding concepts in here removes the redundant
  // Opus pass entirely (see prompt rule for `MISSING CONCEPT`).
  type PageWork = {
    page: string;
    missing: typeof gapReport.domains[number]['functionsMissing'];
    concepts: Array<{ concept: string; frequency: number }>;
  };
  const workByPage = new Map<string, PageWork>();
  for (const d of gapReport.domains) {
    if (d.functionsMissing.length > 0 && d.matchedPage) {
      workByPage.set(d.matchedPage, {
        page: d.matchedPage,
        missing: d.functionsMissing,
        concepts: [],
      });
    }
  }
  for (const c of gapReport.conceptsToDocument) {
    const existing = workByPage.get(c.suggestedPage);
    if (existing) {
      existing.concepts.push({ concept: c.concept, frequency: c.frequency });
    } else {
      workByPage.set(c.suggestedPage, {
        page: c.suggestedPage,
        missing: [],
        concepts: [{ concept: c.concept, frequency: c.frequency }],
      });
    }
  }
  const pagesWithWork = [...workByPage.values()];

  const totalGaps = gapReport.pagesToCreate.length + pagesWithWork.length;
  if (totalGaps === 0) {
    ctx.state.completeTask(updateTaskId, `${gapReport.moduleCoverage.covered}/${gapReport.moduleCoverage.total} domains covered, 0 gaps`);
    ctx.state.startTask(coherenceTaskId, 'skipped (no updates)');
    ctx.state.completeTask(coherenceTaskId, 'skipped (no updates)');
    return;
  }

  ctx.state.updateTask(updateTaskId, `${totalGaps} gaps found, updating…`);
  ctx.renderer.logPlain(`[update] ${gapReport.pagesToCreate.length} pages to create, ${pagesWithWork.length} pages to update, ${gapReport.conceptsToDocument.length} concepts missing`);

  let pagesUpdated = 0;
  for (const work of pagesWithWork) {
    const pagePath = work.page;
    const fullPath = join(outputDir, pagePath);
    const currentContent = existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : '';

    const gapLines: string[] = [];
    for (const fn of work.missing) {
      gapLines.push(`MISSING FUNCTION: ${fn.name} (${fn.file})`);
      gapLines.push(`  Doc summary: ${fn.docSummary || 'no summary'}`);
      gapLines.push(`  → Create documentation for this function.\n`);
    }
    for (const c of work.concepts) {
      gapLines.push(`MISSING CONCEPT: ${c.concept} (referenced ${c.frequency}x in code)`);
      gapLines.push(`  → Add a short paragraph defining the concept on this page.\n`);
    }
    const system = resolveSystemPrompt('doc-generation.updater');
    const user = `## Current page: ${pagePath}\n\n${currentContent}\n\n## Work items\n\n${gapLines.join('\n')}`;

    try {
      ctx.state.trackFile(pagePath);
      const result = await ctx.executor({ system, user, model: 'sonnet' });
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, result.text, 'utf-8');
      ctx.addCost(result.costUsd);
      pagesUpdated++;
      ctx.state.untrackFile(pagePath);
      ctx.state.updateTask(updateTaskId, `${pagesUpdated}/${pagesWithWork.length} pages`);
      ctx.renderer.logPlain(`[update] ${pagesUpdated}/${pagesWithWork.length} ${pagePath}`);
    } catch (err) {
      ctx.state.untrackFile(pagePath);
      ctx.renderer.logPlain(`[update] ${chalk.red('×')} ${pagePath} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  ctx.state.completeTask(updateTaskId, `${pagesUpdated} pages updated (${totalGaps} gaps)`);

  // Pass 1: Structural coherence (lint + auto-fix + Sonnet review)
  ctx.state.startTask(coherenceTaskId, 'linting…');
  const lintResult = reviewDocStructure(outputDir, ctx.projectRoot, ctx.docsPath);
  const structuralFixes = autoFixStructuralIssues(outputDir, lintResult.issues.filter(i => !i.fixed));
  const autoFixed = lintResult.filesFixed + structuralFixes.renames.length + structuralFixes.indexEntriesAdded.length;
  // Re-lint after auto-fix to get accurate unfixed count
  const postFixLint = reviewDocStructure(outputDir, ctx.projectRoot, ctx.docsPath);
  const unfixedIssues = postFixLint.issues.filter(i => !i.fixed);
  ctx.renderer.logPlain(`[lint] ${lintResult.issues.length} issues found, ${autoFixed} auto-fixed, ${unfixedIssues.length} for Sonnet`);
  for (const issue of unfixedIssues.slice(0, 10)) {
    ctx.renderer.logPlain(`[lint]   ${issue.path}: [${issue.rule}] ${issue.detail}`);
  }
  if (unfixedIssues.length > 10) ctx.renderer.logPlain(`[lint]   … and ${unfixedIssues.length - 10} more`);
  ctx.state.updateTask(coherenceTaskId, `coherence review… (${unfixedIssues.length} issues)`);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const structLogDir = anatolyPath(ctx.projectRoot, 'cache', 'logs', 'docs', `structural-review_${ts}`);

  try {
    const structResult = await runDocCoherenceReview({
      outputDir,
      projectRoot: ctx.projectRoot,
      docsPath: ctx.docsPath,
      router: ctx.router,
      logDir: structLogDir,
      callbacks: {
        onToolUse: (_tool, filePath) => {
          const name = filePath.split('/').pop() ?? filePath;
          ctx.state.updateTask(coherenceTaskId, `reviewing ${name}…`);
        },
      },
    });
    ctx.addCost(structResult.costUsd);
    ctx.state.completeTask(coherenceTaskId, structResult.linterIssuesAfter === 0
      ? `structural clean`
      : `${structResult.linterIssuesAfter} structural issues remaining`);
  } catch {
    ctx.state.completeTask(coherenceTaskId, 'structural review failed');
  }
}

/** Registers the `docs` CLI sub-command on the given Commander program. @param program The root Commander instance. */
export function registerDocsCommand(program: Command): void {
  const docs = program
    .command('docs')
    .description('Manage internal documentation (.anatoly/docs/)');

  docs
    .command('scaffold [scope]')
    .description('Scaffold documentation. Scope: "internal" (default, generates .anatoly/docs/) or "project" (copies internal → docs/)')
    .option('-y, --yes', 'skip confirmation prompt')
    .option('--plain', 'linear sequential output')
    .action(async (scope: string | undefined, opts: { yes?: boolean; plain?: boolean }, cmd: { parent?: { parent?: { opts: () => Record<string, unknown> } } }) => {
      // --plain may be captured by the root program (global option), read from parent chain
      const globalOpts = cmd.parent?.parent?.opts?.() ?? {};
      const plain = opts.plain ?? (globalOpts['plain'] as boolean | undefined) ?? false;
      const yes = opts.yes ?? false;

      const effectiveScope = scope ?? 'internal';
      if (effectiveScope !== 'internal' && effectiveScope !== 'project') {
        console.error(chalk.red(`Invalid scope "${effectiveScope}". Use "internal" or "project".`));
        process.exitCode = 1;
        return;
      }

      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      const config = loadConfig(projectRoot);
      const projectDocsPath = getDocsDir(config);
      const internalDocsDir = anatolyPath(projectRoot, 'state/internal-docs');
      const projectDocsDir = resolve(projectRoot, projectDocsPath);

      // --- Project scope: copy internal → project docs ---
      if (effectiveScope === 'project') {
        if (existsSync(projectDocsDir)) {
          console.error(chalk.red(`${projectDocsPath}/ already exists. Delete it first or use gap-detection to update.`));
          process.exitCode = 1;
          return;
        }

        // If internal doesn't exist, scaffold it first
        if (!existsSync(internalDocsDir)) {
          console.log(`  ${chalk.yellow('●')} No internal docs found — scaffolding first…`);
          console.log('');
          // Recursive call to scaffold internal
          const { execSync } = await import('node:child_process');
          execSync(`node ${resolve(projectRoot, 'dist', 'index.js')} docs scaffold internal -y${plain ? ' --plain' : ''}`, {
            cwd: projectRoot,
            stdio: 'inherit',
          });
          console.log('');
        }

        // Copy .anatoly/docs/ → docs/
        const { cpSync } = await import('node:fs');
        cpSync(internalDocsDir, projectDocsDir, { recursive: true });
        // Remove internal artifacts from the copy
        const cachePath = join(projectDocsDir, '.cache.json');
        if (existsSync(cachePath)) rmSync(cachePath);

        console.log(`  ${chalk.green('✓')} Copied .anatoly/docs/ → ${projectDocsPath}/`);
        return;
      }

      // --- Internal scope: full scaffold pipeline ---
      const docsDir = internalDocsDir;

      // Confirmation (skipped with -y)
      if (!yes) {
        if (existsSync(docsDir)) {
          console.log(`This will delete and regenerate ${chalk.bold('.anatoly/docs/')}`);
        } else {
          console.log(`This will generate ${chalk.bold('.anatoly/docs/')} for the first time`);
        }
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>(resolve => rl.question('  Proceed? (y/N) ', resolve));
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          console.log('  cancelled.');
          return;
        }
      }

      // Delete existing
      if (existsSync(docsDir)) {
        rmSync(docsDir, { recursive: true, force: true });
      }

      const result = await runPipeline({
        projectRoot,
        plain,
        bannerMotd: 'Doc Scaffold',
        tasks: [
          { id: 'scaffold', label: 'Internal doc — Scaffold (Sonnet)' },
          { id: 'coherence-1', label: 'Internal doc — Lint + coherence (Sonnet)' },
          { id: 'rag-code', label: 'RAG — Embedding code' },
          { id: 'rag-nlp', label: 'RAG — LLM summaries & embedding' },
          { id: 'rag-doc-project', label: 'RAG — Chunking & embedding project docs' },
          { id: 'rag-doc-internal', label: 'RAG — Chunking & embedding internal docs' },
          { id: 'update', label: 'Internal doc — Update (Sonnet + RAG)' },
          { id: 'coherence-2', label: 'Internal doc — Lint + coherence (Sonnet)' },
          { id: 'coherence-2-content', label: 'Internal doc — Content review (Opus)' },
        ],
        execute: async (ctx) => {
          // --- Step 1: SCAFFOLD (Sonnet, parallel, no RAG) ---
          ctx.state.startTask('scaffold', 'scanning project…');
          await scanProject(ctx.projectRoot, ctx.config);
          const tasks = loadTasks(ctx.projectRoot);

          ctx.state.updateTask('scaffold', 'scaffolding pages…');
          const scaffoldResult = runDocScaffold(ctx.projectRoot, ctx.pkg, tasks, ctx.docsPath, ctx.profile);
          const genResult = runDocGeneration(ctx.projectRoot, scaffoldResult, tasks, ctx.pkg);
          const outputDir = scaffoldResult.outputDir;

          if (genResult.prompts.length === 0) {
            ctx.state.completeTask('scaffold', 'all cached');
          } else {
            let completed = 0;
            const total = genResult.prompts.length;
            ctx.state.updateTask('scaffold', `0/${total} pages`);

            const scaffoldLogDir = anatolyPath(ctx.projectRoot, 'cache', 'logs', 'docs', `scaffold_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
            const llmResult = await executeDocPrompts({
              prompts: genResult.prompts,
              outputDir,
              projectRoot: ctx.projectRoot,
              router: ctx.router,
              executor: ctx.executor,
              logDir: scaffoldLogDir,
              onPageComplete: (pagePath) => {
                completed++;
                // Per-page completion flag — committed only now that the page
                // is on disk, so an interrupted scaffold does not poison the
                // manifest with un-written pages.
                commitDocPage(genResult.cachePath, pagePath, genResult.pageHashes[pagePath] ?? {});
                ctx.state.untrackFile(pagePath);
                ctx.state.updateTask('scaffold', `${completed}/${total} pages`);
                ctx.renderer.logPlain(`[scaffold] ${completed}/${total} ${pagePath}`);
              },
              onPageError: (pagePath, err) => {
                ctx.state.untrackFile(pagePath);
                ctx.renderer.logPlain(`[scaffold] ${chalk.red('×')} ${pagePath} — ${err.message}`);
              },
              onPageStart: (pagePath) => {
                ctx.state.trackFile(pagePath);
              },
            });

            ctx.addCost(llmResult.totalCostUsd);
            const detail = llmResult.pagesFailed > 0
              ? `${llmResult.pagesWritten} written, ${llmResult.pagesFailed} failed`
              : `${llmResult.pagesWritten} pages written`;
            ctx.state.completeTask('scaffold', detail);
          }

          // --- Step 2: LINT + COHERENCE ---
          ctx.state.startTask('coherence-1', 'linting…');
          const scaffoldLint = reviewDocStructure(outputDir, ctx.projectRoot, ctx.docsPath);
          const scaffoldUnfixed = scaffoldLint.issues.filter(i => !i.fixed);
          ctx.renderer.logPlain(`[lint] ${scaffoldLint.issues.length} issues, ${scaffoldLint.filesFixed} auto-fixed, ${scaffoldUnfixed.length} for Sonnet`);
          for (const issue of scaffoldUnfixed.slice(0, 10)) {
            ctx.renderer.logPlain(`[lint]   ${issue.path}: [${issue.rule}] ${issue.detail}`);
          }
          if (scaffoldUnfixed.length > 10) ctx.renderer.logPlain(`[lint]   … and ${scaffoldUnfixed.length - 10} more`);
          ctx.state.updateTask('coherence-1', `coherence review… (${scaffoldUnfixed.length} issues)`);
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const coherenceLogDir = anatolyPath(ctx.projectRoot, 'cache', 'logs', 'docs', `coherence-review_${ts}`);

          try {
            const coherenceResult = await runDocCoherenceReview({
              outputDir,
              projectRoot: ctx.projectRoot,
              docsPath: ctx.docsPath,
              router: ctx.router,
              logDir: coherenceLogDir,
              callbacks: {
                onToolUse: (_tool, filePath) => {
                  const name = filePath.split('/').pop() ?? filePath;
                  ctx.state.updateTask('coherence-1', `reviewing ${name}…`);
                },
              },
            });
            ctx.addCost(coherenceResult.costUsd);
            ctx.state.completeTask('coherence-1',
              coherenceResult.linterIssuesAfter === 0
                ? `clean`
                : `${coherenceResult.linterIssuesBefore} → ${coherenceResult.linterIssuesAfter} issues`,
            );
          } catch {
            ctx.state.completeTask('coherence-1', 'failed');
          }

          // --- Step 4: RAG INDEX (3 sub-phases, same as run) ---
          let ragPhase = 'code';
          let nlpProcessed = 0;
          const ragPhaseToTaskId: Record<string, string> = {
            code: 'rag-code',
            nlp: 'rag-nlp',
            'doc-project': 'rag-doc-project',
            'doc-internal': 'rag-doc-internal',
          };
          ctx.state.startTask('rag-code', '0/?');

          try {
            const ragResult = await indexProjectStandalone({
              projectRoot: ctx.projectRoot,
              tasks,
              docsDir: ctx.docsPath,
              router: ctx.router,
              onLog: (msg) => ctx.renderer.logPlain(`[rag] ${msg}`),
              onProgress: (current, total) => {
                if (ragPhase === 'nlp') nlpProcessed = current;
                if (ragPhase !== 'upsert') {
                  const taskId = ragPhaseToTaskId[ragPhase];
                  if (taskId) ctx.state.updateTask(taskId, `${current}/${total}`);
                }
              },
              onPhase: (phase) => {
                // Complete previous visible task
                if (ragPhase === 'code') {
                  const t = ctx.state.tasks.find(t => t.id === 'rag-code');
                  ctx.state.completeTask('rag-code', t?.detail === '\u2014' ? 'done' : t?.detail ?? 'done');
                } else if (ragPhase === 'nlp') {
                  ctx.state.completeTask('rag-nlp', `${nlpProcessed} files`);
                } else if (ragPhase === 'doc-project') {
                  // Completed in final block with actual section count from ragResult
                }
                ragPhase = phase;
                const taskId = ragPhaseToTaskId[phase];
                if (taskId) ctx.state.startTask(taskId, '0/?');
              },
              onFileStart: (file) => ctx.state.trackFile(file),
              onFileDone: (file) => ctx.state.untrackFile(file),
            });

            // Complete final RAG task
            // Ensure all tasks are completed with meaningful details
            if (ctx.state.tasks.find(t => t.id === 'rag-code' && t.status !== 'done'))
              ctx.state.completeTask('rag-code', `${ragResult.totalCards} functions (${ragResult.totalFiles} files)`);
            const nlpTask = ctx.state.tasks.find(t => t.id === 'rag-nlp');
            if (nlpTask && nlpTask.status !== 'done')
              ctx.state.completeTask('rag-nlp', nlpTask.status === 'pending' ? 'cached' : `${ragResult.totalCards} cards`);
            if (ctx.state.tasks.find(t => t.id === 'rag-doc-project' && t.status !== 'done'))
              ctx.state.completeTask('rag-doc-project', ragResult.docsIdentical
                ? 'deduplicated (= internal)'
                : ragResult.projectDocSections > 0
                  ? `${ragResult.projectDocSections} sections` : ragResult.projectDocsCached ? 'cached' : 'no project docs');
            if (ctx.state.tasks.find(t => t.id === 'rag-doc-internal' && t.status !== 'done'))
              ctx.state.completeTask('rag-doc-internal', ragResult.internalDocSections > 0
                ? `${ragResult.internalDocSections} sections` : ragResult.internalDocsCached ? 'cached' : 'no internal docs');
          } catch (err) {
            ctx.state.completeTask('rag-code', 'failed');
            ctx.state.completeTask('rag-nlp', 'failed');
            ctx.state.completeTask('rag-doc-project', 'failed');
            ctx.state.completeTask('rag-doc-internal', 'failed');
            ctx.renderer.logPlain(`[rag] ${chalk.red(err instanceof Error ? err.message : String(err))}`);
          }

          // --- Steps 5-6: RAG-DRIVEN UPDATE + LINT + COHERENCE ---
          await runDocUpdate(ctx, outputDir, 'update', 'coherence-2');
        },
      });

      // Summary
      const elapsed = (result.durationMs / 1000).toFixed(1);
      console.log('');
      console.log(`  ${chalk.green('✓')} Doc scaffold complete — ${elapsed}s · $${result.totalCostUsd.toFixed(4)}`);
      console.log(`    ${chalk.dim(`docs: .anatoly/state/internal-docs/`)}`);
      if (existsSync(anatolyPath(projectRoot, 'cache', 'logs', 'docs'))) {
        console.log(`    ${chalk.dim(`logs: .anatoly/cache/logs/docs/`)}`);
      }
    });

  docs
    .command('lint')
    .description('Lint .anatoly/docs/ structure (fix preamble, fences, check index, links)')
    .action(() => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      const docsDir = anatolyPath(projectRoot, 'state/internal-docs');
      if (!existsSync(docsDir)) {
        console.error(chalk.red('No internal docs found. Run `anatoly docs scaffold` first.'));
        process.exitCode = 1;
        return;
      }

      const config = loadConfig(projectRoot);
      const docsPath = getDocsDir(config);

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const logDir = anatolyPath(projectRoot, 'cache', 'logs', 'docs', `structure-review_${ts}`);

      console.log(`  ${chalk.yellow('●')} Structure lint`);

      try {
        const result = reviewDocStructure(docsDir, projectRoot, docsPath, undefined, {
          logDir,
          callbacks: {
            onCollected: (fileCount, sizeKb) => {
              console.log(`    ${chalk.dim('collected')} ${fileCount} files (${sizeKb} KB)`);
            },
            onCheck: (rule, count) => {
              if (count > 0) {
                console.log(`    ${chalk.yellow(rule)} ${count} issue${count > 1 ? 's' : ''}`);
              } else {
                console.log(`    ${chalk.green(rule)} ok`);
              }
            },
            onFileFixed: (path, rule) => {
              console.log(`    ${chalk.green('fixed')} ${path} (${rule})`);
            },
          },
        });

        console.log('');
        const unfixed = result.issues.filter(i => !i.fixed);
        if (result.issues.length === 0) {
          console.log(`  ${chalk.green('✓')} no issues across ${result.filesScanned} files`);
        } else if (unfixed.length === 0) {
          console.log(`  ${chalk.green('✓')} ${result.issues.length} issues auto-fixed in ${result.filesFixed} files`);
        } else {
          console.log(`  ${chalk.yellow('!')} ${result.issues.length} issues — ${result.filesFixed} files auto-fixed, ${unfixed.length} need manual attention:`);
          for (const issue of unfixed) {
            console.log(`    ${chalk.dim('›')} ${issue.path}: ${issue.detail}`);
          }
        }

        const relLogDir = relative(projectRoot, logDir);
        console.log(`    ${chalk.dim(`log: ${relLogDir}/`)}`);
      } catch (err) {
        console.log(`  ${chalk.red('×')} Structure lint — failed`);
        console.error(`    ${chalk.red(err instanceof Error ? err.message : String(err))}`);
        process.exitCode = 1;
      }
    });

  docs
    .command('coherence')
    .description('Run structure lint + coherence review on .anatoly/docs/')
    .option('--lint-only', 'skip coherence review, only run deterministic lint + auto-fix')
    .action(async (opts: { lintOnly?: boolean }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      const docsDir = anatolyPath(projectRoot, 'state/internal-docs');
      if (!existsSync(docsDir)) {
        console.error(chalk.red('No internal docs found. Run `anatoly docs scaffold` first.'));
        process.exitCode = 1;
        return;
      }

      const config = loadConfig(projectRoot);
      const docsPath = getDocsDir(config);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

      // Step 1: Deterministic lint
      const lintLogDir = anatolyPath(projectRoot, 'cache', 'logs', 'docs', `structure-lint_${ts}`);
      console.log(`  ${chalk.yellow('●')} Structure lint`);

      const lintResult = reviewDocStructure(docsDir, projectRoot, docsPath, undefined, {
        logDir: lintLogDir,
        callbacks: {
          onCollected: (fileCount, sizeKb) => {
            console.log(`    ${chalk.dim('collected')} ${fileCount} files (${sizeKb} KB)`);
          },
          onCheck: (rule, count) => {
            if (count > 0) {
              console.log(`    ${chalk.yellow(rule)} ${count} issue${count > 1 ? 's' : ''}`);
            } else {
              console.log(`    ${chalk.green(rule)} ok`);
            }
          },
          onFileFixed: (path, rule) => {
            console.log(`    ${chalk.green('fixed')} ${path} (${rule})`);
          },
        },
      });

      const unfixed = lintResult.issues.filter(i => !i.fixed);
      if (lintResult.issues.length === 0) {
        console.log(`  ${chalk.green('✓')} Structure lint — clean`);
      } else {
        console.log(`  ${chalk.green('✓')} Structure lint — ${lintResult.filesFixed} auto-fixed, ${unfixed.length} remaining`);
      }

      // Step 2: Sonnet coherence review (unless --lint-only)
      if (opts.lintOnly) {
        if (unfixed.length > 0) {
          console.log('');
          for (const issue of unfixed) {
            console.log(`    ${chalk.dim('›')} ${issue.path}: ${issue.detail}`);
          }
        }
        console.log(`    ${chalk.dim(`log: ${relative(projectRoot, lintLogDir)}/`)}`);
        return;
      }

      if (unfixed.length === 0 && lintResult.filesFixed === 0) {
        console.log(`    ${chalk.dim('skipping coherence review — no issues')}`);
        return;
      }

      console.log('');
      console.log(`  ${chalk.yellow('●')} Coherence review ${chalk.dim('(sonnet)')}`);

      const coherenceLogDir = anatolyPath(projectRoot, 'cache', 'logs', 'docs', `coherence-review_${ts}`);

      try {
        const result = await runDocCoherenceReview({
          outputDir: docsDir,
          projectRoot,
          docsPath,
          logDir: coherenceLogDir,
          callbacks: {
            onToolUse: (_tool, filePath) => {
              const name = filePath.split('/').pop() ?? filePath;
              console.log(`    ${chalk.dim(`reviewing ${name}…`)}`);
            },
          },
        });

        console.log('');
        if (result.linterIssuesAfter === 0) {
          console.log(`  ${chalk.green('✓')} Coherence review — all issues resolved`);
        } else {
          console.log(`  ${chalk.yellow('!')} Coherence review — ${result.linterIssuesBefore} → ${result.linterIssuesAfter} issues`);
        }
        console.log(`    ${chalk.dim(`cost: $${result.costUsd.toFixed(4)} · ${(result.durationMs / 1000).toFixed(1)}s`)}`);
        console.log(`    ${chalk.dim(`log: ${relative(projectRoot, coherenceLogDir)}/`)}`);
      } catch (err) {
        console.log(`  ${chalk.red('×')} Coherence review — failed`);
        console.error(`    ${chalk.red(err instanceof Error ? err.message : String(err))}`);
        process.exitCode = 1;
      }
    });

  docs
    .command('index')
    .description('Incremental RAG indexing: code cards + NLP summaries + doc chunks')
    .option('--plain', 'linear sequential output')
    .option('--rebuild', 'force full re-index (re-embed, reuse Haiku caches)')
    .option('--drop-cache', 'drop all caches including Haiku summaries and chunks (use with --rebuild)')
    .action(async (opts: { plain?: boolean; rebuild?: boolean; dropCache?: boolean }, cmd: { parent?: { parent?: { opts: () => Record<string, unknown> } } }) => {
      const globalPlain = cmd.parent?.parent?.opts?.()?.['plain'] as boolean | undefined;
      const plainMode = opts.plain ?? globalPlain ?? false;
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      const docsDir = anatolyPath(projectRoot, 'state/internal-docs');
      if (!existsSync(docsDir)) {
        console.error(chalk.red('No internal docs found. Run `anatoly docs scaffold` first.'));
        process.exitCode = 1;
        return;
      }

      // Check that docs are generated (not scaffold-only)
      const { readdirSync, statSync } = await import('node:fs');
      let hasScaffoldOnly = false;
      const checkScaffold = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) { checkScaffold(full); continue; }
          if (!entry.endsWith('.md') || entry === 'index.md') continue;
          const content = readFileSync(full, 'utf-8');
          if (content.includes('<!-- SCAFFOLDING')) {
            hasScaffoldOnly = true;
            return;
          }
        }
      };
      checkScaffold(docsDir);
      if (hasScaffoldOnly) {
        console.error(chalk.red('Internal docs contain scaffold-only pages (<!-- SCAFFOLDING markers).'));
        console.error(chalk.red('Run `anatoly docs scaffold` to generate content first.'));
        process.exitCode = 1;
        return;
      }

      // Drop doc-related caches + NLP summary cache (contains docSummary needed for gap detection)
      if (opts.dropCache) {
        const ragDir = anatolyPath(projectRoot, 'cache/rag');
        if (existsSync(ragDir)) {
          const cachePatterns = ['doc_chunk_cache_', 'cache_advanced-internal', 'cache_lite-internal', 'nlp_summary_cache_'];
          const cacheFiles = readdirSync(ragDir).filter(f =>
            f.endsWith('.json') && cachePatterns.some(p => f.includes(p)),
          );
          for (const file of cacheFiles) {
            rmSync(resolve(ragDir, file));
            console.log(`  ${chalk.dim('dropped')} ${file}`);
          }
        }
      }

      const result = await runPipeline({
        projectRoot,
        plain: plainMode,
        bannerMotd: 'Doc Index',
        tasks: [
          { id: 'scan', label: 'Scanning project' },
          { id: 'rag-code', label: 'Embedding code' },
          { id: 'rag-nlp', label: 'LLM summaries & embedding' },
          { id: 'rag-doc-project', label: 'Chunking & embedding project docs' },
          { id: 'rag-doc-internal', label: 'Chunking & embedding internal docs' },
        ],
        execute: async (ctx) => {
          // Step 1: Scan
          ctx.state.startTask('scan', 'scanning…');
          const docsScanResult = await scanProject(ctx.projectRoot, ctx.config);
          const tasks = loadTasks(ctx.projectRoot);
          ctx.state.completeTask('scan', `${tasks.length} files (${docsScanResult.filesNew} new, ${docsScanResult.filesCached} cached)`);

          // Step 2: RAG index (3 sub-phases)
          let ragPhase = 'code';
          let idxNlpProcessed = 0;
          ctx.state.startTask('rag-code', '0/?');

          try {
            const ragResult = await indexProjectStandalone({
              projectRoot: ctx.projectRoot,
              tasks,
              rebuild: opts.rebuild,
              docsDir: ctx.docsPath,
              router: ctx.router,
              onLog: (msg) => ctx.renderer.logPlain(`[rag] ${msg}`),
              onProgress: (current, total) => {
                if (ragPhase === 'nlp') idxNlpProcessed = current;
                if (ragPhase !== 'upsert') {
                  const phaseMap: Record<string, string> = { code: 'rag-code', nlp: 'rag-nlp', 'doc-project': 'rag-doc-project', 'doc-internal': 'rag-doc-internal' };
                  const tid = phaseMap[ragPhase];
                  if (tid) ctx.state.updateTask(tid, `${current}/${total}`);
                }
              },
              onPhase: (phase) => {
                if (ragPhase === 'code') {
                  const t = ctx.state.tasks.find(t => t.id === 'rag-code');
                  ctx.state.completeTask('rag-code', t?.detail === '\u2014' ? 'done' : t?.detail ?? 'done');
                } else if (ragPhase === 'nlp') {
                  ctx.state.completeTask('rag-nlp', `${idxNlpProcessed} files`);
                } else if (ragPhase === 'doc-project') {
                  // Completed in final block with actual section count from ragResult
                }
                ragPhase = phase;
                const phaseMap: Record<string, string> = { code: 'rag-code', nlp: 'rag-nlp', 'doc-project': 'rag-doc-project', 'doc-internal': 'rag-doc-internal' };
                const taskId = phaseMap[phase];
                if (taskId) ctx.state.startTask(taskId, '0/?');
              },
              onFileStart: (file) => ctx.state.trackFile(file),
              onFileDone: (file) => ctx.state.untrackFile(file),
            });

            // Ensure all tasks completed
            if (ctx.state.tasks.find(t => t.id === 'rag-code' && t.status !== 'done'))
              ctx.state.completeTask('rag-code', `${ragResult.totalCards} functions (${ragResult.totalFiles} files)`);
            const idxNlp = ctx.state.tasks.find(t => t.id === 'rag-nlp');
            if (idxNlp && idxNlp.status !== 'done')
              ctx.state.completeTask('rag-nlp', idxNlp.status === 'pending' ? 'cached' : `${ragResult.totalCards} cards`);
            if (ctx.state.tasks.find(t => t.id === 'rag-doc-project' && t.status !== 'done'))
              ctx.state.completeTask('rag-doc-project', ragResult.docsIdentical
                ? 'deduplicated (= internal)'
                : ragResult.projectDocSections > 0
                  ? `${ragResult.projectDocSections} sections` : ragResult.projectDocsCached ? 'cached' : 'no project docs');
            if (ctx.state.tasks.find(t => t.id === 'rag-doc-internal' && t.status !== 'done'))
              ctx.state.completeTask('rag-doc-internal', ragResult.internalDocSections > 0
                ? `${ragResult.internalDocSections} sections` : ragResult.internalDocsCached ? 'cached' : 'no internal docs');
          } catch (err) {
            ctx.state.completeTask('rag-code', 'failed');
            ctx.state.completeTask('rag-nlp', 'failed');
            ctx.state.completeTask('rag-doc-project', 'failed');
            ctx.state.completeTask('rag-doc-internal', 'failed');
            ctx.renderer.logPlain(`[rag] ${chalk.red(err instanceof Error ? err.message : String(err))}`);
            process.exitCode = 1;
          }
        },
      });

      const elapsed = (result.durationMs / 1000).toFixed(1);
      console.log('');
      console.log(`  ${chalk.green('✓')} Index complete — ${elapsed}s`);
    });

  docs
    .command('update')
    .description('RAG-driven doc update: gap detection → targeted Sonnet update → lint + coherence')
    .option('--plain', 'linear sequential output')
    .action(async (opts: { plain?: boolean }, cmd: { parent?: { parent?: { opts: () => Record<string, unknown> } } }) => {
      const globalPlain = cmd.parent?.parent?.opts?.()?.['plain'] as boolean | undefined;
      const plain = opts.plain ?? globalPlain ?? false;
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      const docsDir = anatolyPath(projectRoot, 'state/internal-docs');
      if (!existsSync(docsDir)) {
        console.error(chalk.red('No internal docs found. Run `anatoly docs scaffold` first.'));
        process.exitCode = 1;
        return;
      }

      // Check RAG index exists
      const ragDir = anatolyPath(projectRoot, 'cache/rag/lancedb');
      if (!existsSync(ragDir)) {
        console.error(chalk.red('No RAG index found. Run `anatoly docs index` first.'));
        process.exitCode = 1;
        return;
      }

      const result = await runPipeline({
        projectRoot,
        plain,
        bannerMotd: 'Doc Update',
        tasks: [
          { id: 'update', label: 'Internal doc — Update (Sonnet + RAG)' },
          { id: 'coherence', label: 'Internal doc — Structural coherence (Sonnet)' },
          { id: 'coherence-content', label: 'Internal doc — Content review (Opus)' },
        ],
        execute: async (ctx) => {
          const outputDir = anatolyPath(ctx.projectRoot, 'state/internal-docs');
          await runDocUpdate(ctx, outputDir, 'update', 'coherence');
        },
      });

      const elapsed = (result.durationMs / 1000).toFixed(1);
      console.log('');
      console.log(`  ${chalk.green('✓')} Doc update complete — ${elapsed}s · $${result.totalCostUsd.toFixed(4)}`);
    });

  docs
    .command('gap-detection <scope>')
    .description('Analyze coverage gaps between code index and doc index. Scope: "internal" (.anatoly/docs/) or "project" (docs/)')
    .option('--gap-threshold <n>', 'similarity below this = NOT_FOUND', '0.60')
    .option('--drift-threshold <n>', 'similarity below this = LOW_RELEVANCE', '0.85')
    .option('--json', 'output as JSON')
    .action(async (scope: string, opts: { gapThreshold?: string; driftThreshold?: string; json?: boolean }) => {
      const projectRoot = process.cwd();

      if (scope !== 'internal' && scope !== 'project') {
        console.error(chalk.red(`Invalid scope "${scope}". Use "internal" (.anatoly/docs/) or "project" (docs/).`));
        process.exitCode = 1;
        return;
      }

      // Check that RAG index exists
      const ragDir = anatolyPath(projectRoot, 'cache/rag/lancedb');
      if (!existsSync(ragDir)) {
        console.error(chalk.red('No RAG index found. Run `anatoly docs index` first.'));
        process.exitCode = 1;
        return;
      }

      const config = loadConfig(projectRoot);
      const docsPath = getDocsDir(config);
      const targetDir = scope === 'internal' ? join('.anatoly', 'state', 'internal-docs') : docsPath;

      if (!existsSync(resolve(projectRoot, targetDir))) {
        console.error(chalk.red(`${targetDir}/ not found.${scope === 'internal' ? ' Run `anatoly docs scaffold` first.' : ''}`));
        process.exitCode = 1;
        return;
      }

      const tableName = resolveRagTableName(projectRoot);
      const store = new VectorStore(projectRoot, tableName);
      await store.init();

      // Verify code index is populated
      const allCards = await store.listAll();
      if (allCards.length === 0) {
        console.error(chalk.red('Code index is empty. Run `anatoly docs index` first.'));
        process.exitCode = 1;
        return;
      }

      console.log(`  ${chalk.yellow('●')} Gap detection ${chalk.dim(`${scope} · 3-strategy analysis`)}`);
      console.log('');

      const report = await detectDocGapsV2(store, {
        scope: scope as 'internal' | 'project',
        projectDocsPath: docsPath,
        onProgress: (phase, current, total) => {
          if (!opts.json) {
            process.stdout.write(`\r    ${phase}: ${current}/${total}…`);
          }
        },
      });

      if (!opts.json) {
        process.stdout.write('\r\x1b[K');
        console.log(formatGapReportV2(report));

        const totalGaps = report.pagesToCreate.length + report.pagesToUpdate.length + report.conceptsToDocument.length;
        console.log('');
        if (totalGaps === 0) {
          console.log(`  ${chalk.green('✓')} Documentation is healthy`);
        } else {
          console.log(`  ${chalk.yellow('!')} ${totalGaps} items need attention`);
        }
      } else {
        console.log(JSON.stringify(report, null, 2));
      }
    });

  docs
    .command('status')
    .description('Show internal documentation status')
    .action(() => {
      const projectRoot = process.cwd();
      const docsDir = anatolyPath(projectRoot, 'state/internal-docs');

      if (!existsSync(docsDir)) {
        console.log('  No internal docs found. Run `anatoly docs scaffold` or `anatoly run` to generate.');
        return;
      }

      // Count pages
      let total = 0;
      let scaffoldOnly = 0;
      const countFiles = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            countFiles(full);
          } else if (entry.endsWith('.md') && entry !== 'index.md') {
            total++;
            const content = readFileSync(full, 'utf-8');
            if (content.includes('<!-- SCAFFOLDING') && content.replace(/<!--[\s\S]*?-->/g, '').replace(/^#+\s.*/gm, '').trim().length < 200) {
              scaffoldOnly++;
            }
          }
        }
      };
      countFiles(docsDir);

      const generated = total - scaffoldOnly;
      console.log(`  .anatoly/docs/: ${total} pages (${generated} generated, ${scaffoldOnly} scaffolded-only)`);
    });

  docs
    .command('identity')
    .description('Check if docs/ and .anatoly/docs/ are identical (deduplicated) or standalone')
    .action(() => {
      const projectRoot = process.cwd();
      const config = loadConfig(projectRoot);
      const projectDocsDir = getDocsDir(config);
      const internalDocsDir = join('.anatoly', 'state', 'internal-docs');

      const absProject = resolve(projectRoot, projectDocsDir);
      const absInternal = resolve(projectRoot, internalDocsDir);

      const projectExists = existsSync(absProject);
      const internalExists = existsSync(absInternal);

      if (!projectExists && !internalExists) {
        console.log(chalk.yellow('  No documentation found.'));
        console.log(`  Neither ${projectDocsDir}/ nor .anatoly/docs/ exist.`);
        console.log('  Run `anatoly docs scaffold` or `anatoly run` to generate.');
        return;
      }

      if (!internalExists) {
        console.log(chalk.cyan('  Standalone') + ` — only ${projectDocsDir}/ exists (no internal docs)`);
        return;
      }

      if (!projectExists) {
        console.log(chalk.cyan('  Internal only') + ' — .anatoly/docs/ exists, no project docs');
        console.log(`  Run \`anatoly docs scaffold project\` to copy to ${projectDocsDir}/`);
        return;
      }

      // Both exist — compare
      const identical = areDocTreesIdentical(projectRoot, projectDocsDir, internalDocsDir);

      if (identical) {
        console.log(chalk.green('  Deduplicated') + ` — ${projectDocsDir}/ is identical to .anatoly/docs/`);
        console.log('  RAG indexing will chunk only .anatoly/docs/ and alias the results.');
      } else {
        console.log(chalk.blue('  Standalone') + ` — ${projectDocsDir}/ differs from .anatoly/docs/`);
        console.log('  RAG indexing will chunk both trees independently.');
      }
    });

  docs
    .command('reset-project')
    .description('Replace docs/ with a fresh copy of .anatoly/docs/ (overwrites all project docs)')
    .option('-y, --yes', 'skip confirmation prompt')
    .action(async (opts: { yes?: boolean }) => {
      const projectRoot = process.cwd();
      const config = loadConfig(projectRoot);
      const projectDocsPath = getDocsDir(config);
      const absProject = resolve(projectRoot, projectDocsPath);
      const absInternal = anatolyPath(projectRoot, 'state/internal-docs');

      if (!existsSync(absInternal)) {
        console.error(chalk.red('  .anatoly/docs/ does not exist. Run `anatoly docs scaffold` first.'));
        process.exitCode = 1;
        return;
      }

      const projectExists = existsSync(absProject);
      const identical = projectExists && areDocTreesIdentical(projectRoot, projectDocsPath, join('.anatoly', 'state', 'internal-docs'));

      if (identical) {
        console.log(chalk.green('  Already identical') + ` — ${projectDocsPath}/ is already a copy of .anatoly/docs/`);
        return;
      }

      // Confirmation
      if (!opts.yes) {
        if (projectExists) {
          console.log(chalk.yellow(`  ⚠ This will delete ${projectDocsPath}/ and replace it with .anatoly/docs/`));
          console.log('  All manual edits in project docs will be lost.');
        } else {
          console.log(`  This will copy .anatoly/docs/ → ${projectDocsPath}/`);
        }
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>(r => rl.question('  Proceed? (y/N) ', r));
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          console.log('  Cancelled.');
          return;
        }
      }

      // Guard against symlinks (rmSync would destroy the symlink target)
      if (projectExists) {
        try {
          if (lstatSync(absProject).isSymbolicLink()) {
            console.error(chalk.red(`${projectDocsPath}/ is a symlink — refusing to delete. Remove the symlink manually first.`));
            process.exitCode = 1;
            return;
          }
        } catch { /* proceed */ }
        rmSync(absProject, { recursive: true, force: true });
      }

      // Copy .anatoly/docs/ → docs/
      cpSync(absInternal, absProject, { recursive: true });

      // Remove internal artifacts from the copy
      const cachePath = join(absProject, '.cache.json');
      if (existsSync(cachePath)) rmSync(cachePath);

      console.log(`  ${chalk.green('✓')} Replaced ${projectDocsPath}/ with .anatoly/docs/`);
      console.log('  Doc trees are now identical — RAG indexing will deduplicate automatically.');
    });

  // --- Story 55.6: arbitrate ---

  const arbitrate = docs
    .command('arbitrate')
    .description('Interactive wizard to resolve doc-code conflicts')
    .option('--list', 'Display summary table without interactive wizard')
    .option('--review', 'Re-review previously applied verdicts')
    .option('--no-refresh', 'Skip the optional LLM refresh prompt at start')
    .action(async (opts: { list?: boolean; review?: boolean; refresh?: boolean }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      const wizardOpts: Parameters<typeof runArbitrateWizard>[1] = {
        ...(opts.list ? { list: true } : {}),
        ...(opts.review ? { review: true } : {}),
      };
      // The default for commander --no-X flags is true; --no-refresh sets it to false.
      if (opts.refresh !== false && !opts.list && !opts.review) {
        try {
          wizardOpts.refreshFn = buildRefreshFn(projectRoot);
        } catch (err) {
          // Config or router build failure is non-fatal: the wizard still runs
          // on the existing ledger without the refresh option.
          console.warn(chalk.yellow(`Could not build refresh: ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      const result = await runArbitrateWizard(projectRoot, wizardOpts);

      if (result.error) {
        console.error(chalk.red(result.error));
      }
      if (result.message) {
        console.log(result.message);
      }
      if (result.table) {
        console.log(result.table);
      }
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
    });

  arbitrate
    .command('refresh')
    .description('Run only the LLM refresh pass over pending conflicts, then exit')
    .option('--dry-run', 'Inspect and report what would change without writing')
    .action(async (opts: { dryRun?: boolean }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      let refreshFn: RefreshFn;
      try {
        refreshFn = buildRefreshFn(projectRoot);
      } catch (err) {
        console.error(chalk.red(`Could not build refresh: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
        return;
      }

      const result = await runRefreshStandalone(projectRoot, {
        refreshFn,
        ...(opts.dryRun ? { dryRun: true } : {}),
      });

      if (result.error) console.error(chalk.red(result.error));
      if (result.message) console.log(result.message);
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });
}

function buildRouter(config: Config): TransportRouter {
  const nativeTransports: Record<string, LlmTransport> = {
    anthropic: new AnthropicTransport(),
  };
  const providerModes: Record<string, ProviderModeConfig> = {};
  for (const [id, prov] of Object.entries(config.providers)) {
    if (prov) providerModes[id] = { mode: prov.mode, single_turn: prov.single_turn, agents: prov.agents, concurrency: prov.concurrency };
  }
  return new TransportRouter({
    nativeTransports,
    vercelSdkTransport: new VercelSdkTransport(config),
    providerModes,
  });
}

/** How many `arbitrate refresh` transcript dirs to keep under
 *  `.anatoly/refresh/`. Observability output, not a cache, so it gets a
 *  small bounded history rather than unbounded growth. */
const REFRESH_RUNS_KEPT = 10;

function buildRefreshFn(projectRoot: string): RefreshFn {
  const config = loadConfig(projectRoot);
  const router = buildRouter(config);
  // Timestamped observability dir for LLM conversation transcripts.
  //
  // This is NOT placed under `.anatoly/cache/`: transcripts are forensic,
  // non-reproducible output (rerunning never reproduces them, nothing is
  // read back by key), so they are not a content-addressable cache. Living
  // in the cache tree was actively harmful — `cache snapshot` would mirror
  // them into every snapshot, `cache restore` would wipe the in-flight
  // arbitration history, and `cache prune` never touched them (unbounded
  // growth). It is also kept out of `.anatoly/runs/`, which is reserved for
  // real audit runs. Instead it lives under the shared standalone-command
  // observability namespace `.anatoly/commands/<command>/` (here `refresh`),
  // with simple keep-most-recent-N retention.
  const refreshRoot = commandPath(projectRoot, 'refresh');
  pruneTimestampedRuns(refreshRoot, REFRESH_RUNS_KEPT - 1);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(refreshRoot, ts);
  return async (entries) => refreshPendingConflicts(entries, { projectRoot, config, router, runDir });
}
