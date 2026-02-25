import type { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';
import { estimateProject, formatTokenCount, loadTasks, estimateSequentialSeconds, estimateMinutesWithConcurrency } from '../core/estimator.js';

export function registerEstimateCommand(program: Command): void {
  program
    .command('estimate')
    .description('Estimate token count and review time via tiktoken (no LLM calls)')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      // Auto-scan if no tasks directory exists
      const tasksDir = resolve(projectRoot, '.anatoly', 'tasks');
      if (!existsSync(tasksDir)) {
        const scanResult = await scanProject(projectRoot, config);
        console.log('anatoly — scan (auto)');
        console.log(`  files     ${scanResult.filesScanned}`);
        console.log('');
      }

      const result = estimateProject(projectRoot);
      const concurrency = config.llm.concurrency;
      const tasks = loadTasks(projectRoot);
      const seqSeconds = estimateSequentialSeconds(tasks);
      const minutes = estimateMinutesWithConcurrency(seqSeconds, concurrency);

      console.log('anatoly — estimate');
      console.log('');
      console.log(`  files        ${result.files}`);
      console.log(`  symbols      ${result.symbols}`);
      console.log(`  est. tokens  ${formatTokenCount(result.inputTokens)} input / ${formatTokenCount(result.outputTokens)} output`);
      const timeLabel = concurrency > 1
        ? `~${minutes} min (×${concurrency})`
        : `~${minutes} min`;
      console.log(`  est. time    ${timeLabel}`);
    });
}
