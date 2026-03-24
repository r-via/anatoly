// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import chalk from 'chalk';
import { isLockActive } from '../utils/lock.js';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';
import { loadTasks } from '../core/estimator.js';
import { runDocScaffold, runDocGeneration } from '../core/doc-pipeline.js';
import { executeDocPrompts, reviewDocStructure, runDocCoherenceReview } from '../core/doc-llm-executor.js';
import { runPipeline } from '../cli/pipeline-runner.js';
import { indexProjectStandalone } from '../rag/standalone.js';
import { detectDocGaps, formatGapSummary } from '../core/doc-gap-detection.js';
import { VectorStore } from '../rag/vector-store.js';

export function registerDocsCommand(program: Command): void {
  const docs = program
    .command('docs')
    .description('Manage internal documentation (.anatoly/docs/)');

  docs
    .command('scaffold')
    .description('Full doc scaffold pipeline: generate → lint → coherence → RAG → refine → lint → coherence → re-index')
    .option('-y, --yes', 'skip confirmation prompt')
    .option('--plain', 'linear sequential output')
    .action(async (opts: { yes?: boolean; plain?: boolean }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      const docsDir = resolve(projectRoot, '.anatoly', 'docs');

      // Confirmation
      if (!opts.yes) {
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
        plain: opts.plain ?? false,
        bannerMotd: 'Doc Scaffold',
        tasks: [
          { id: 'scaffold', label: 'Scaffold (Sonnet)' },
          { id: 'coherence-1', label: 'Lint + coherence (Opus)' },
          { id: 'rag-code', label: 'Indexing & embedding code' },
          { id: 'rag-nlp', label: 'Summaries & embedding code' },
          { id: 'rag-doc', label: 'Chunking & embedding docs' },
          { id: 'update', label: 'Update (Sonnet + RAG)' },
          { id: 'coherence-2', label: 'Lint + coherence (Opus)' },
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

            const llmResult = await executeDocPrompts({
              prompts: genResult.prompts,
              outputDir,
              projectRoot: ctx.projectRoot,
              semaphore: ctx.semaphore,
              executor: ctx.executor,
              onPageComplete: (pagePath) => {
                completed++;
                ctx.state.updateTask('scaffold', `${completed}/${total} pages`);
                ctx.renderer.logPlain(`[scaffold] ${completed}/${total} ${pagePath}`);
              },
              onPageError: (pagePath, err) => {
                ctx.renderer.logPlain(`[scaffold] ${chalk.red('×')} ${pagePath} — ${err.message}`);
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
          reviewDocStructure(outputDir, ctx.projectRoot, ctx.docsPath);
          ctx.state.updateTask('coherence-1', 'coherence review…');
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const coherenceLogDir = resolve(ctx.projectRoot, '.anatoly', 'logs', 'docs', `coherence-review_${ts}`);

          try {
            const coherenceResult = await runDocCoherenceReview({
              outputDir,
              projectRoot: ctx.projectRoot,
              docsPath: ctx.docsPath,
              logDir: coherenceLogDir,
              callbacks: {
                onLoopStart: (loop) => {
                  ctx.state.updateTask('coherence-1', `loop ${loop}…`);
                },
                onLoopEnd: (loop, issues) => {
                  ctx.renderer.logPlain(`[coherence] loop ${loop} done — ${issues} issues remaining`);
                },
              },
            });
            ctx.addCost(coherenceResult.costUsd);
            ctx.state.completeTask('coherence-1',
              coherenceResult.linterIssuesAfter === 0
                ? `clean (${coherenceResult.loopsCompleted} loops)`
                : `${coherenceResult.linterIssuesBefore} → ${coherenceResult.linterIssuesAfter} issues`,
            );
          } catch {
            ctx.state.completeTask('coherence-1', 'failed');
          }

          // --- Step 4: RAG INDEX (3 sub-phases, same as run) ---
          let ragPhase = 'code';
          const ragPhaseToTaskId: Record<string, string> = {
            code: 'rag-code',
            nlp: 'rag-nlp',
            upsert: 'rag-nlp', // upsert updates the active nlp task
            doc: 'rag-doc',
          };
          ctx.state.startTask('rag-code', '0/?');

          try {
            const ragResult = await indexProjectStandalone({
              projectRoot: ctx.projectRoot,
              tasks,
              docsDir: ctx.docsPath,
              semaphore: ctx.semaphore,
              onLog: (msg) => ctx.renderer.logPlain(`[rag] ${msg}`),
              onProgress: (current, total) => {
                const taskId = ragPhaseToTaskId[ragPhase];
                if (taskId) ctx.state.updateTask(taskId, `${current}/${total}`);
              },
              onPhase: (phase) => {
                const prevTaskId = ragPhaseToTaskId[ragPhase];
                const nextTaskId = ragPhaseToTaskId[phase];
                // Complete previous phase task
                if (prevTaskId && prevTaskId !== nextTaskId) {
                  const prevTask = ctx.state.tasks.find(t => t.id === prevTaskId);
                  ctx.state.completeTask(prevTaskId, prevTask?.detail === '\u2014' ? 'done' : prevTask?.detail ?? 'done');
                }
                ragPhase = phase;
                // Start next phase task
                if (nextTaskId) ctx.state.startTask(nextTaskId, '0/?');
              },
              onFileStart: (file) => ctx.state.trackFile(file),
              onFileDone: (file) => ctx.state.untrackFile(file),
            });

            // Complete final RAG task
            const finalTaskId = ragPhaseToTaskId[ragPhase];
            if (finalTaskId) {
              const detail = ragPhase === 'doc'
                ? `${ragResult.docSectionsIndexed} sections`
                : `${ragResult.totalCards} cards`;
              ctx.state.completeTask(finalTaskId, detail);
            }
            // Ensure all 3 tasks are completed
            if (ctx.state.tasks.find(t => t.id === 'rag-code' && t.status !== 'done')) {
              ctx.state.completeTask('rag-code', `${ragResult.totalCards} functions (${ragResult.totalFiles} files)`);
            }
            if (ctx.state.tasks.find(t => t.id === 'rag-nlp' && t.status !== 'done')) {
              ctx.state.completeTask('rag-nlp', `${ragResult.totalCards} cards`);
            }
            if (ctx.state.tasks.find(t => t.id === 'rag-doc' && t.status !== 'done')) {
              ctx.state.completeTask('rag-doc', `${ragResult.docSectionsIndexed} sections`);
            }
          } catch (err) {
            ctx.state.completeTask('rag-code', 'failed');
            ctx.state.completeTask('rag-nlp', 'failed');
            ctx.state.completeTask('rag-doc', 'failed');
            ctx.renderer.logPlain(`[rag] ${chalk.red(err instanceof Error ? err.message : String(err))}`);
          }

          // --- Step 5: UPDATE with RAG (re-generate, cache invalidated by coherence writes) ---
          ctx.state.startTask('update', 'checking cache…');
          const genResult2 = runDocGeneration(ctx.projectRoot, scaffoldResult, tasks, ctx.pkg);

          if (genResult2.prompts.length === 0) {
            ctx.state.completeTask('update', 'all cached');
          } else {
            let completed2 = 0;
            const total2 = genResult2.prompts.length;
            ctx.state.updateTask('update', `0/${total2} pages`);

            const llmResult2 = await executeDocPrompts({
              prompts: genResult2.prompts,
              outputDir,
              projectRoot: ctx.projectRoot,
              semaphore: ctx.semaphore,
              executor: ctx.executor,
              onPageComplete: (pagePath) => {
                completed2++;
                ctx.state.updateTask('update', `${completed2}/${total2} pages`);
                ctx.renderer.logPlain(`[update] ${completed2}/${total2} ${pagePath}`);
              },
              onPageError: (pagePath, err) => {
                ctx.renderer.logPlain(`[update] ${chalk.red('×')} ${pagePath} — ${err.message}`);
              },
            });

            ctx.addCost(llmResult2.totalCostUsd);
            ctx.state.completeTask('update', llmResult2.pagesFailed > 0
              ? `${llmResult2.pagesWritten} written, ${llmResult2.pagesFailed} failed`
              : `${llmResult2.pagesWritten} pages updated`);
          }

          // --- Step 5: LINT + COHERENCE on updated pages ---
          ctx.state.startTask('coherence-2', 'linting…');
          if (genResult2.prompts.length > 0) {
            reviewDocStructure(outputDir, ctx.projectRoot, ctx.docsPath);
            ctx.state.updateTask('coherence-2', 'coherence review…');
            const ts2 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const coherenceLogDir2 = resolve(ctx.projectRoot, '.anatoly', 'logs', 'docs', `coherence-review-2_${ts2}`);

            try {
              const coherenceResult2 = await runDocCoherenceReview({
                outputDir,
                projectRoot: ctx.projectRoot,
                docsPath: ctx.docsPath,
                logDir: coherenceLogDir2,
                callbacks: {
                  onLoopStart: (loop) => ctx.state.updateTask('coherence-2', `coherence loop ${loop}…`),
                  onLoopEnd: (loop, issues) => ctx.renderer.logPlain(`[coherence-2] loop ${loop} done — ${issues} remaining`),
                },
              });
              ctx.addCost(coherenceResult2.costUsd);
              ctx.state.completeTask('coherence-2', coherenceResult2.linterIssuesAfter === 0
                ? `clean (${coherenceResult2.loopsCompleted} loops)`
                : `${coherenceResult2.linterIssuesAfter} issues remaining`);
            } catch {
              ctx.state.completeTask('coherence-2', 'coherence failed');
            }
          } else {
            ctx.state.completeTask('coherence-2', 'skipped (no updates)');
          }
        },
      });

      // Summary
      const elapsed = (result.durationMs / 1000).toFixed(1);
      console.log('');
      console.log(`  ${chalk.green('✓')} Doc scaffold complete — ${elapsed}s · $${result.totalCostUsd.toFixed(4)}`);
      console.log(`    ${chalk.dim(`docs: .anatoly/docs/`)}`);
      if (existsSync(resolve(projectRoot, '.anatoly', 'logs', 'docs'))) {
        console.log(`    ${chalk.dim(`logs: .anatoly/logs/docs/`)}`);
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

      const docsDir = resolve(projectRoot, '.anatoly', 'docs');
      if (!existsSync(docsDir)) {
        console.error(chalk.red('No internal docs found. Run `anatoly docs scaffold` first.'));
        process.exitCode = 1;
        return;
      }

      const config = loadConfig(projectRoot);
      const docsPath = config.documentation?.docs_path ?? 'docs';

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const logDir = resolve(projectRoot, '.anatoly', 'logs', 'docs', `structure-review_${ts}`);

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
    .command('review-internal')
    .description('Run structure lint + Opus coherence review on .anatoly/docs/')
    .option('--max-loops <n>', 'max audit-fix-verify loops', '3')
    .option('--lint-only', 'skip Opus coherence review, only run deterministic lint')
    .action(async (opts: { maxLoops?: string; lintOnly?: boolean }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      const docsDir = resolve(projectRoot, '.anatoly', 'docs');
      if (!existsSync(docsDir)) {
        console.error(chalk.red('No internal docs found. Run `anatoly docs scaffold` first.'));
        process.exitCode = 1;
        return;
      }

      const config = loadConfig(projectRoot);
      const docsPath = config.documentation?.docs_path ?? 'docs';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

      // Step 1: Deterministic lint
      const lintLogDir = resolve(projectRoot, '.anatoly', 'logs', 'docs', `structure-lint_${ts}`);
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

      // Step 2: Opus coherence review (unless --lint-only)
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
      console.log(`  ${chalk.yellow('●')} Coherence review ${chalk.dim('(opus)')}`);

      const coherenceLogDir = resolve(projectRoot, '.anatoly', 'logs', 'docs', `coherence-review_${ts}`);

      try {
        const result = await runDocCoherenceReview({
          outputDir: docsDir,
          projectRoot,
          docsPath,
          maxLoops: parseInt(opts.maxLoops ?? '3', 10),
          logDir: coherenceLogDir,
          callbacks: {
            onLoopStart: (loop) => {
              console.log(`    ${chalk.dim(`loop ${loop}…`)}`);
            },
            onLoopEnd: (loop, issues) => {
              if (issues === 0) {
                console.log(`    ${chalk.green(`loop ${loop} done — clean`)}`);
              } else {
                console.log(`    ${chalk.yellow(`loop ${loop} done — ${issues} linter issues remaining`)}`);
              }
            },
          },
        });

        console.log('');
        if (result.linterIssuesAfter === 0) {
          console.log(`  ${chalk.green('✓')} Coherence review — all issues resolved in ${result.loopsCompleted} loop${result.loopsCompleted > 1 ? 's' : ''}`);
        } else {
          console.log(`  ${chalk.yellow('!')} Coherence review — ${result.linterIssuesBefore} → ${result.linterIssuesAfter} issues (${result.loopsCompleted} loops)`);
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
    .option('--rebuild', 'force full re-index (ignore cache)')
    .action(async (opts: { plain?: boolean; rebuild?: boolean }) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish.'));
        process.exitCode = 1;
        return;
      }

      const docsDir = resolve(projectRoot, '.anatoly', 'docs');
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

      const result = await runPipeline({
        projectRoot,
        plain: opts.plain ?? false,
        bannerMotd: 'Doc Index',
        tasks: [
          { id: 'scan', label: 'Scanning project' },
          { id: 'rag-code', label: 'Indexing & embedding code' },
          { id: 'rag-nlp', label: 'Summaries & embedding code' },
          { id: 'rag-doc', label: 'Chunking & embedding docs' },
        ],
        execute: async (ctx) => {
          // Step 1: Scan
          ctx.state.startTask('scan', 'scanning…');
          await scanProject(ctx.projectRoot, ctx.config);
          const tasks = loadTasks(ctx.projectRoot);
          ctx.state.completeTask('scan', `${tasks.length} files`);

          // Step 2: RAG index (3 sub-phases)
          let ragPhase = 'code';
          const phaseToTask: Record<string, string> = { code: 'rag-code', nlp: 'rag-nlp', upsert: 'rag-nlp', doc: 'rag-doc' };
          ctx.state.startTask('rag-code', '0/?');

          try {
            const ragResult = await indexProjectStandalone({
              projectRoot: ctx.projectRoot,
              tasks,
              rebuild: opts.rebuild,
              docsDir: ctx.docsPath,
              semaphore: ctx.semaphore,
              onLog: (msg) => ctx.renderer.logPlain(`[rag] ${msg}`),
              onProgress: (current, total) => {
                const tid = phaseToTask[ragPhase];
                if (tid) ctx.state.updateTask(tid, `${current}/${total}`);
              },
              onPhase: (phase) => {
                const prev = phaseToTask[ragPhase];
                const next = phaseToTask[phase];
                if (prev && prev !== next) {
                  const t = ctx.state.tasks.find(t => t.id === prev);
                  ctx.state.completeTask(prev, t?.detail === '\u2014' ? 'done' : t?.detail ?? 'done');
                }
                ragPhase = phase;
                if (next) ctx.state.startTask(next, '0/?');
              },
              onFileStart: (file) => ctx.state.trackFile(file),
              onFileDone: (file) => ctx.state.untrackFile(file),
            });

            // Ensure all tasks completed
            if (ctx.state.tasks.find(t => t.id === 'rag-code' && t.status !== 'done'))
              ctx.state.completeTask('rag-code', `${ragResult.totalCards} functions (${ragResult.totalFiles} files)`);
            if (ctx.state.tasks.find(t => t.id === 'rag-nlp' && t.status !== 'done'))
              ctx.state.completeTask('rag-nlp', `${ragResult.totalCards} cards`);
            if (ctx.state.tasks.find(t => t.id === 'rag-doc' && t.status !== 'done'))
              ctx.state.completeTask('rag-doc', `${ragResult.docSectionsIndexed} sections`);
          } catch (err) {
            ctx.state.completeTask('rag-code', 'failed');
            ctx.state.completeTask('rag-nlp', 'failed');
            ctx.state.completeTask('rag-doc', 'failed');
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
    .command('gap-detection')
    .description('Analyze coverage gaps between code index and doc index (no LLM, pure vector analysis)')
    .option('--gap-threshold <n>', 'similarity below this = NOT_FOUND', '0.60')
    .option('--drift-threshold <n>', 'similarity below this = LOW_RELEVANCE', '0.85')
    .option('--json', 'output as JSON')
    .action(async (opts: { gapThreshold?: string; driftThreshold?: string; json?: boolean }) => {
      const projectRoot = process.cwd();

      // Check that RAG index exists
      const ragDir = resolve(projectRoot, '.anatoly', 'rag', 'lancedb');
      if (!existsSync(ragDir)) {
        console.error(chalk.red('No RAG index found. Run `anatoly docs scaffold` or `anatoly run` first.'));
        process.exitCode = 1;
        return;
      }

      const store = new VectorStore(projectRoot);
      await store.init();

      // Verify indexes are populated
      const allCards = await store.listAll();
      const allDocs = await store.listDocSections();
      if (allCards.length === 0) {
        console.error(chalk.red('Code index is empty. Run `anatoly docs index` first.'));
        process.exitCode = 1;
        return;
      }
      if (allDocs.length === 0) {
        console.error(chalk.red('Doc index is empty. Run `anatoly docs index` first (requires .anatoly/docs/).'));
        process.exitCode = 1;
        return;
      }

      const gapThreshold = parseFloat(opts.gapThreshold ?? '0.60');
      const driftThreshold = parseFloat(opts.driftThreshold ?? '0.85');

      console.log(`  ${chalk.yellow('●')} Gap detection ${chalk.dim(`(gap < ${gapThreshold}, drift < ${driftThreshold})`)}`);
      console.log('');

      const result = await detectDocGaps(store, {
        gapThreshold,
        driftThreshold,
        onProgress: (current, total) => {
          if (!opts.json) {
            process.stdout.write(`\r    analyzing ${current}/${total} functions…`);
          }
        },
      });

      if (!opts.json) {
        process.stdout.write('\r\x1b[K');
        console.log(formatGapSummary(result));
        console.log('');

        const totalWork = result.notFound.length + result.lowRelevance.length + result.orphans.length;
        if (totalWork === 0) {
          console.log(`  ${chalk.green('✓')} All ${result.covered.length} functions are documented`);
        } else {
          console.log(`  ${chalk.yellow('!')} ${totalWork} items need attention`);
        }
      } else {
        const output = {
          totalFunctions: result.totalFunctions,
          totalDocSections: result.totalDocSections,
          notFound: result.notFound.map(i => ({ function: i.functionCard.name, file: i.functionCard.filePath, similarity: i.similarity })),
          lowRelevance: result.lowRelevance.map(i => ({ function: i.functionCard.name, file: i.functionCard.filePath, matchedSection: i.bestMatch?.name, similarity: i.similarity })),
          covered: result.covered.length,
          orphans: result.orphans.map(i => ({ section: i.docSection.name, file: i.docSection.filePath })),
        };
        console.log(JSON.stringify(output, null, 2));
      }
    });

  docs
    .command('status')
    .description('Show internal documentation status')
    .action(() => {
      const projectRoot = process.cwd();
      const docsDir = resolve(projectRoot, '.anatoly', 'docs');

      if (!existsSync(docsDir)) {
        console.log('  No internal docs found. Run `anatoly docs scaffold` or `anatoly run` to generate.');
        return;
      }

      // Count pages
      let total = 0;
      let scaffoldOnly = 0;
      const countFiles = (dir: string) => {
        const { readdirSync, statSync } = require('node:fs');
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
}
