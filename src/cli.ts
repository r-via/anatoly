import { Command } from 'commander';
import {
  registerScanCommand,
  registerEstimateCommand,
  registerReviewCommand,
  registerReportCommand,
  registerRunCommand,
  registerWatchCommand,
  registerStatusCommand,
  registerCleanLogsCommand,
  registerResetCommand,
} from './commands/index.js';

export function createProgram(): Command {
  const program = new Command()
    .name('anatoly')
    .version('0.1.0')
    .description('Deep Audit Agent for TypeScript codebases')
    .option('--config <path>', 'path to .anatoly.yml config file')
    .option('--verbose', 'show detailed operation logs')
    .option('--no-cache', 'ignore SHA-256 cache, re-review all files')
    .option('--file <glob>', 'restrict scope to matching files')
    .option('--plain', 'disable log-update, linear sequential output')
    .option('--no-color', 'disable chalk colors')
    .option('--enable-rag', 'enable semantic RAG cross-file analysis')
    .option('--rebuild-rag', 'force full RAG re-indexation');

  registerScanCommand(program);
  registerEstimateCommand(program);
  registerReviewCommand(program);
  registerReportCommand(program);
  registerRunCommand(program);
  registerWatchCommand(program);
  registerStatusCommand(program);
  registerCleanLogsCommand(program);
  registerResetCommand(program);

  return program;
}
