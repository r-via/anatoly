// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import { isLockActive } from '../utils/lock.js';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';
import { loadTasks } from '../core/estimator.js';
import { runDocScaffold, runDocGeneration } from '../core/doc-pipeline.js';
import { executeDocPrompts, type DocExecutor } from '../core/doc-llm-executor.js';
import { Semaphore } from '../core/sdk-semaphore.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

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

      const scaffoldResult = runDocScaffold(projectRoot, pkg, tasks, docsPath);
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

      const executor: DocExecutor = async ({ system, user, model }) => {
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
