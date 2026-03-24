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
          { id: 'scaffold', label: 'Scaffolding documentation' },
          { id: 'lint-1', label: 'Structure lint' },
          { id: 'coherence-1', label: 'Coherence review' },
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

          // --- Step 2: LINT ---
          ctx.state.startTask('lint-1', 'checking structure…');
          const lintResult = reviewDocStructure(outputDir, ctx.projectRoot, ctx.docsPath);
          const lintIssues = lintResult.issues.filter(i => !i.fixed).length;
          ctx.state.completeTask('lint-1', lintResult.filesFixed > 0
            ? `${lintResult.filesFixed} auto-fixed, ${lintIssues} remaining`
            : lintIssues > 0 ? `${lintIssues} issues` : 'clean');

          // --- Step 3: COHERENCE ---
          ctx.state.startTask('coherence-1', 'reviewing coherence…');
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

          // TODO: Steps 4-6 (RAG index → update with RAG → coherence → re-index)
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
