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
import { detectProjectProfile } from '../core/language-detect.js';
import { executeDocPrompts, reviewDocStructure, runDocCoherenceReview, type DocExecutor } from '../core/doc-llm-executor.js';
import { Semaphore } from '../core/sdk-semaphore.js';
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
    .command('rebuild')
    .description('Delete and regenerate all internal documentation from scratch')
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
        console.log(`  ${chalk.red('×')} deleted .anatoly/docs/`);
      }

      // Load config and scan
      const config = loadConfig(projectRoot);
      console.log('  scanning project...');
      await scanProject(projectRoot, config);
      const tasks = loadTasks(projectRoot);

      // Scaffold + generate
      const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
      const docsPath = config.documentation?.docs_path ?? 'docs';

      const profile = detectProjectProfile(projectRoot);
      const scaffoldResult = runDocScaffold(projectRoot, pkg, tasks, docsPath, profile);
      console.log(`  scaffolded ${scaffoldResult.scaffoldResult.pagesCreated.length} pages`);

      const genResult = runDocGeneration(projectRoot, scaffoldResult, tasks, pkg);
      if (genResult.prompts.length === 0) {
        console.log(`  ${chalk.green('✓')} all pages cached — nothing to generate`);
        return;
      }

      console.log(`  generating ${genResult.prompts.length} pages via Sonnet...`);

      // Execute LLM
      const semaphore = new Semaphore(config.llm.sdk_concurrency);
      let completed = 0;
      const total = genResult.prompts.length;

      const executor = createDocExecutor(projectRoot);

      const result = await executeDocPrompts({
        prompts: genResult.prompts,
        outputDir: scaffoldResult.outputDir,
        projectRoot,
        semaphore,
        executor,
        onPageComplete: (pagePath) => {
          completed++;
          console.log(`  ${chalk.green('✓')} [${completed}/${total}] ${pagePath}`);
        },
        onPageError: (pagePath, err) => {
          console.log(`  ${chalk.red('×')} [${completed + 1}/${total}] ${pagePath} — ${err.message}`);
        },
      });

      console.log('');
      const summary = result.pagesFailed > 0
        ? `${result.pagesWritten} written, ${result.pagesFailed} failed`
        : `${result.pagesWritten} pages written`;
      console.log(`  ${chalk.green('✓')} internal docs rebuilt — ${summary}`);
      if (result.totalCostUsd > 0) {
        console.log(`  cost: $${result.totalCostUsd.toFixed(4)}`);
      }

      // Structure review pass
      console.log(`  reviewing structure via Opus...`);
      try {
        const reviewResult = await reviewDocStructure(scaffoldResult.outputDir, projectRoot, docsPath, executor);
        if (reviewResult.filesFixed > 0) {
          console.log(`  ${chalk.green('✓')} fixed ${reviewResult.filesFixed} structural issues`);
        }
        if (reviewResult.costUsd > 0) {
          console.log(`  review cost: $${reviewResult.costUsd.toFixed(4)}`);
        }
      } catch {
        console.log(`  ${chalk.yellow('⚠')} structure review skipped (LLM error)`);
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
        console.error(chalk.red('No internal docs found. Run `anatoly docs rebuild` first.'));
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
        console.error(chalk.red('No internal docs found. Run `anatoly docs rebuild` first.'));
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
        console.log('  No internal docs found. Run `anatoly docs rebuild` or `anatoly run` to generate.');
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
