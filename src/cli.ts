import { Command } from 'commander';
import chalk from 'chalk';
import {
  registerScanCommand,
  registerEstimateCommand,
  registerReviewCommand,
  registerReportCommand,
  registerRunCommand,
  registerWatchCommand,
  registerStatusCommand,
  registerCleanRunsCommand,
  registerResetCommand,
  registerRagStatusCommand,
  registerHookCommand,
} from './commands/index.js';
import { pkgVersion } from './utils/version.js';
import { initLogger, resolveLogLevel, LOG_LEVELS } from './utils/logger.js';

// Respect $NO_COLOR convention (https://no-color.org/)
if ('NO_COLOR' in process.env) {
  chalk.level = 0;
}

export function createProgram(): Command {
  const program = new Command()
    .name('anatoly')
    .version(pkgVersion)
    .description('Deep Audit Agent for TypeScript codebases')
    .option('--config <path>', 'path to .anatoly.yml config file')
    .option('--verbose', 'show detailed operation logs')
    .option('--no-cache', 'ignore SHA-256 cache, re-review all files')
    .option('--file <glob>', 'restrict scope to matching files')
    .option('--plain', 'disable log-update, linear sequential output')
    .option('--no-color', 'disable chalk colors (also respects $NO_COLOR env var)')
    .option('--no-rag', 'disable semantic RAG cross-file analysis')
    .option('--rebuild-rag', 'force full RAG re-indexation')
    .option('--dual-embedding', 'enable dual code+NLP embedding for RAG (generates NLP summaries via LLM)')
    .option('--no-dual-embedding', 'disable dual embedding (code-only, overrides config)')
    .option('--open', 'open report in default app after generation')
    .option('--concurrency <n>', 'number of concurrent reviews (1-10)', parseInt)
    .option('--no-triage', 'disable triage, review all files with full agent')
    .option('--deliberation', 'enable Opus deliberation pass after axis merge')
    .option('--no-deliberation', 'disable deliberation pass (overrides config)')
    .option('--no-badge', 'skip README badge injection after audit')
    .option('--badge-verdict', 'include audit verdict in README badge')
    .option('--log-level <level>', 'set log level (fatal, error, warn, info, debug, trace)')
    .option('--log-file <path>', 'write logs to file in ndjson format');

  // Initialize logger before any command runs
  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    const logLevel = opts.logLevel as string | undefined;

    // Validate --log-level value
    if (logLevel && !LOG_LEVELS.includes(logLevel as never)) {
      console.error(
        `Invalid log level: "${logLevel}". Valid levels: ${LOG_LEVELS.join(', ')}`,
      );
      process.exit(1);
    }

    const level = resolveLogLevel({ logLevel, verbose: opts.verbose as boolean | undefined });
    initLogger({
      level,
      logFile: opts.logFile as string | undefined,
      pretty: opts.noColor ? false : undefined,
    });
  });

  registerScanCommand(program);
  registerEstimateCommand(program);
  registerReviewCommand(program);
  registerReportCommand(program);
  registerRunCommand(program);
  registerWatchCommand(program);
  registerStatusCommand(program);
  registerCleanRunsCommand(program);
  registerResetCommand(program);
  registerRagStatusCommand(program);
  registerHookCommand(program);

  return program;
}
