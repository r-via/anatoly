import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { execSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import chalk from 'chalk';
import { parseUncheckedActions } from './fix.js';

const COMPLETION_SIGNAL = '<promise>COMPLETE</promise>';

export function registerFixRunCommand(program: Command): void {
  program
    .command('fix-run <report-file>')
    .description('Generate fix artifacts and run Ralph loop via Claude Agent SDK')
    .option('-n, --iterations <n>', 'max Ralph iterations', '10')
    .action(async (reportFile: string, opts: { iterations: string }) => {
      const projectRoot = process.cwd();
      const absPath = resolve(projectRoot, reportFile);
      const maxIterations = parseInt(opts.iterations, 10) || 10;

      if (!existsSync(absPath)) {
        console.error(chalk.red(`File not found: ${reportFile}`));
        process.exit(1);
      }

      // Derive shard name and fix directory
      const shardName = basename(reportFile, '.md');
      const fixDir = resolve(projectRoot, '.anatoly', 'fix', shardName);
      const prdPath = join(fixDir, 'prd.json');
      const claudeMdPath = join(fixDir, 'CLAUDE.md');
      const progressPath = join(fixDir, 'progress.txt');

      // Generate artifacts if not already present
      if (!existsSync(prdPath) || !existsSync(claudeMdPath)) {
        console.log(chalk.blue('Generating fix artifacts...'));
        execSync(`npx anatoly fix ${reportFile}`, {
          cwd: projectRoot,
          stdio: 'inherit',
        });
      }

      // Verify artifacts were created
      if (!existsSync(prdPath)) {
        const content = readFileSync(absPath, 'utf-8');
        const items = parseUncheckedActions(content);
        if (items.length === 0) {
          console.log(chalk.yellow('No unchecked actions found — nothing to fix.'));
          return;
        }
        console.error(chalk.red('Fix artifacts not found after generation.'));
        process.exit(1);
      }

      const claudeMd = readFileSync(claudeMdPath, 'utf-8');

      console.log('');
      console.log(chalk.blue(`Ralph fix loop — ${maxIterations} iterations max`));
      console.log('');

      for (let i = 1; i <= maxIterations; i++) {
        console.log('===============================================================');
        console.log(`  Ralph Iteration ${i} of ${maxIterations}`);
        console.log('===============================================================');

        // Build prompt with current prd.json and progress.txt context
        const prdContent = readFileSync(prdPath, 'utf-8');
        const progressContent = existsSync(progressPath) ? readFileSync(progressPath, 'utf-8') : '';

        const prompt = [
          claudeMd,
          '',
          '## Current PRD State',
          '```json',
          prdContent,
          '```',
          '',
          progressContent ? `## Current Progress\n\n${progressContent}` : '',
        ].join('\n');

        let outputText = '';

        try {
          const q = query({
            prompt,
            options: {
              model: 'claude-sonnet-4-6',
              cwd: projectRoot,
              maxTurns: 50,
              permissionMode: 'bypassPermissions',
              allowDangerouslySkipPermissions: true,
            },
          });

          for await (const event of q) {
            if (event.type === 'result') {
              const result = event.result;
              if ('resultText' in result) {
                outputText = result.resultText;
                console.log(chalk.gray(`  Tokens: ${result.inputTokens} in / ${result.outputTokens} out`));
              }
            } else if (event.type === 'message' && event.message.role === 'assistant') {
              // Stream assistant text to console
              const msg = event.message;
              if ('content' in msg) {
                for (const block of msg.content as Array<{ type: string; text?: string }>) {
                  if (block.type === 'text' && block.text) {
                    process.stdout.write(block.text);
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error(chalk.yellow(`  Iteration ${i} error: ${err instanceof Error ? err.message : String(err)}`));
        }

        // Sync completed fixes back to the report
        try {
          execSync(`npx anatoly fix-sync ${reportFile}`, {
            cwd: projectRoot,
            stdio: 'pipe',
          });
        } catch {
          // Non-fatal
        }

        // Check for completion signal
        if (outputText.includes(COMPLETION_SIGNAL)) {
          console.log('');
          console.log(chalk.green(`All fixes complete! Finished at iteration ${i}.`));

          // Final sync
          try {
            execSync(`npx anatoly fix-sync ${reportFile}`, {
              cwd: projectRoot,
              stdio: 'inherit',
            });
          } catch {
            // Non-fatal
          }
          return;
        }

        // Check if all stories pass in prd.json
        try {
          const currentPrd = JSON.parse(readFileSync(prdPath, 'utf-8'));
          const allDone = currentPrd.userStories?.every((s: { passes: boolean }) => s.passes);
          if (allDone) {
            console.log('');
            console.log(chalk.green(`All stories marked as passing. Finished at iteration ${i}.`));
            return;
          }
        } catch {
          // Continue if prd.json can't be parsed
        }

        console.log(`\nIteration ${i} complete.\n`);
      }

      console.log('');
      console.log(chalk.yellow(`Ralph reached max iterations (${maxIterations}).`));
      console.log(chalk.yellow(`Check .anatoly/fix/${shardName}/progress.txt for status.`));
      process.exitCode = 1;
    });
}
