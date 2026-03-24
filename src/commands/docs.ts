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
import { detectProjectProfile, formatLanguageLine, formatFrameworkLine } from '../core/language-detect.js';
import { executeDocPrompts, reviewDocStructure, runDocCoherenceReview, type DocExecutor } from '../core/doc-llm-executor.js';
import { Semaphore } from '../core/sdk-semaphore.js';
import { PipelineState } from '../cli/pipeline-state.js';
import { ScreenRenderer } from '../cli/screen-renderer.js';
import { printBanner } from '../utils/banner.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

function createDocExecutor(projectRoot: string): DocExecutor {
  return async ({ system, user, model }) => {
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

    for await (const message of q) {
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

    return { text: resultText, costUsd };
  };
}

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

      // Setup
      const config = loadConfig(projectRoot);
      const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
      const docsPath = config.documentation?.docs_path ?? 'docs';
      const profile = detectProjectProfile(projectRoot);
      const semaphore = new Semaphore(config.llm.sdk_concurrency);
      const executor = createDocExecutor(projectRoot);
      const plain = opts.plain ?? false;
      const startTime = Date.now();
      let totalCostUsd = 0;

      // Initialize pipeline UI
      const pipelineState = new PipelineState();
      pipelineState.setSemaphore(semaphore);
      pipelineState.addTask('scaffold', 'Scaffolding documentation');
      pipelineState.addTask('lint-1', 'Structure lint');
      pipelineState.addTask('coherence-1', 'Coherence review');
      // Steps 4-6 (RAG → update → coherence) are future — placeholder for now
      const renderer = new ScreenRenderer(pipelineState, { plain });

      // Print banner + project info
      if (!plain) {
        printBanner('Doc Scaffold');
        const langLine = formatLanguageLine(profile.languages.languages);
        const fwLine = formatFrameworkLine(profile.frameworks);
        if (langLine) console.log(`  ${chalk.dim('languages')}  ${langLine}`);
        if (fwLine) console.log(`  ${chalk.dim('frameworks')} ${fwLine}`);
        console.log(`  ${chalk.dim('types')}      ${profile.types.join(', ')}`);
        console.log('');
      }

      renderer.start();

      try {
        // --- Step 1: SCAFFOLD (Sonnet, parallel, no RAG) ---
        pipelineState.startTask('scaffold', 'scanning project…');
        await scanProject(projectRoot, config);
        const tasks = loadTasks(projectRoot);

        pipelineState.updateTask('scaffold', 'scaffolding pages…');
        const scaffoldResult = runDocScaffold(projectRoot, pkg, tasks, docsPath, profile);
        const genResult = runDocGeneration(projectRoot, scaffoldResult, tasks, pkg);
        const outputDir = scaffoldResult.outputDir;

        if (genResult.prompts.length === 0) {
          pipelineState.completeTask('scaffold', 'all cached');
        } else {
          let completed = 0;
          const total = genResult.prompts.length;
          pipelineState.updateTask('scaffold', `0/${total} pages`);

          const result = await executeDocPrompts({
            prompts: genResult.prompts,
            outputDir,
            projectRoot,
            semaphore,
            executor,
            onPageComplete: (pagePath) => {
              completed++;
              pipelineState.updateTask('scaffold', `${completed}/${total} pages`);
              renderer.logPlain(`[scaffold] ${completed}/${total} ${pagePath}`);
            },
            onPageError: (pagePath, err) => {
              renderer.logPlain(`[scaffold] ${chalk.red('×')} ${pagePath} — ${err.message}`);
            },
          });

          totalCostUsd += result.totalCostUsd;
          const detail = result.pagesFailed > 0
            ? `${result.pagesWritten} written, ${result.pagesFailed} failed`
            : `${result.pagesWritten} pages written`;
          pipelineState.completeTask('scaffold', detail);
        }

        // --- Step 2: LINT + COHERENCE ---
        pipelineState.startTask('lint-1', 'checking structure…');
        const lintResult = reviewDocStructure(outputDir, projectRoot, docsPath);
        const lintIssues = lintResult.issues.filter(i => !i.fixed).length;
        pipelineState.completeTask('lint-1', lintResult.filesFixed > 0
          ? `${lintResult.filesFixed} auto-fixed, ${lintIssues} remaining`
          : lintIssues > 0 ? `${lintIssues} issues` : 'clean');

        // --- Step 3: COHERENCE ---
        pipelineState.startTask('coherence-1', 'reviewing coherence…');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const coherenceLogDir = resolve(projectRoot, '.anatoly', 'logs', 'docs', `coherence-review_${ts}`);

        try {
          const coherenceResult = await runDocCoherenceReview({
            outputDir,
            projectRoot,
            docsPath,
            logDir: coherenceLogDir,
            callbacks: {
              onLoopStart: (loop) => {
                pipelineState.updateTask('coherence-1', `loop ${loop}…`);
              },
              onLoopEnd: (loop, issues) => {
                renderer.logPlain(`[coherence] loop ${loop} done — ${issues} issues remaining`);
              },
            },
          });
          totalCostUsd += coherenceResult.costUsd;
          pipelineState.completeTask('coherence-1',
            coherenceResult.linterIssuesAfter === 0
              ? `clean (${coherenceResult.loopsCompleted} loops)`
              : `${coherenceResult.linterIssuesBefore} → ${coherenceResult.linterIssuesAfter} issues`,
          );
        } catch {
          pipelineState.completeTask('coherence-1', 'failed');
        }

        // TODO: Steps 4-6 (RAG index → update with RAG → coherence → re-index)
        // Will be implemented when RAG integration is available in standalone mode

      } finally {
        renderer.stop();
      }

      // Summary
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log('');
      console.log(`  ${chalk.green('✓')} Doc scaffold complete — ${elapsed}s · $${totalCostUsd.toFixed(4)}`);
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
