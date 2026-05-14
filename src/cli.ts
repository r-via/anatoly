// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { Command } from 'commander';
import chalk from 'chalk';
import {
  registerEstimateCommand,
  registerReviewCommand,
  registerReportCommand,
  registerRunCommand,
  registerWatchCommand,
  registerResetCommand,
  registerRagStatusCommand,
  registerHookCommand,
  registerCleanCommand,
  registerCleanRunCommand,
  registerCleanSyncCommand,
  registerCleanSharedCommand,
  registerLocalEmbeddingsCommand,
  registerInitCommand,
  registerDocsCommand,
  registerProvidersCommand,
  registerNotificationsCommand,
  registerRunsCommand,
  registerAttachCommand,
  registerGitCommand,
  runAutoGitCleanup,
} from './commands/index.js';
import { pkgVersionString } from './utils/version.js';
import { initLogger, resolveLogLevel, LOG_LEVELS, getLogger } from './utils/logger.js';
import { bootstrapAnatoly } from './utils/anatoly-paths.js';

// Respect $NO_COLOR convention (https://no-color.org/)
if ('NO_COLOR' in process.env) {
  chalk.level = 0;
}

/**
 * Create and configure the Anatoly CLI program.
 *
 * Builds a Commander instance with all global options, registers a `preAction`
 * hook that initializes the logger (validating `--log-level`, resolving
 * verbosity), and registers all subcommands (scan, review, report, run, etc.).
 *
 * @returns Fully configured Commander program ready to be parsed.
 */
export function createProgram(): Command {
  const program = new Command()
    .name('anatoly')
    .version(pkgVersionString)
    .description('Deep Audit Agent for codebases')
    .option('--config <path>', 'path to .anatoly.yml config file')
    .option('--verbose', 'show detailed operation logs')
    .option('--plain', 'disable log-update, linear sequential output')
    .option('--no-color', 'disable chalk colors (also respects $NO_COLOR env var)')
    .option('--no-rag', 'disable semantic RAG cross-file analysis')
    .option('--rag-lite', 'force lite RAG mode (Jina dual embedding)')
    .option('--rag-advanced', 'force advanced RAG mode (GGUF Docker GPU)')
    .option('--open', 'open report in default app after generation')
    .option('--log-level <level>', 'set log level (fatal, error, warn, info, debug, trace)')
    .option('--log-file <path>', 'write logs to file in ndjson format');

  // Initialize logger and apply --no-color before any command runs
  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();

    // --no-color: disable chalk globally (complement $NO_COLOR env var)
    if (opts.color === false) {
      chalk.level = 0;
    }

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
      pretty: opts.color === false ? false : undefined,
    });

    // Auto-cleanup orphaned worktrees before any command (Story 47.7)
    runAutoGitCleanup(process.cwd());

    // Bootstrap user-wide `~/.anatoly/` + project `.anatoly/` symlinks
    // (Story 52.5). Idempotent: respects existing real directories
    // (isolated mode), creates symlinks otherwise.
    try {
      bootstrapAnatoly(process.cwd());
    } catch (err) {
      // Bootstrap is best-effort — paths still resolve lazily via anatolyPath.
      // Log and continue so a broken HOME or read-only filesystem doesn't
      // brick every command.
      const log = getLogger();
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'bootstrap failed — continuing without symlinks');
    }
  });

  registerEstimateCommand(program);
  registerReviewCommand(program);
  registerReportCommand(program);
  registerRunCommand(program);
  registerWatchCommand(program);
  // Parent "clean" command with subcommands: generate, run, sync
  const cleanCmd = program.command('clean').description('Clean loop commands (generate, run, sync)');
  registerCleanCommand(cleanCmd);
  registerCleanRunCommand(cleanCmd);
  registerCleanSyncCommand(cleanCmd);
  registerCleanSharedCommand(cleanCmd);

  registerResetCommand(program);
  registerRagStatusCommand(program);
  registerHookCommand(program);
  registerLocalEmbeddingsCommand(program);
  registerInitCommand(program);
  registerDocsCommand(program);
  registerProvidersCommand(program);

  // Parent "notifications" command with subcommands: create-bot, test
  const notificationsCmd = program.command('notifications').description('Telegram notification setup and testing');
  registerNotificationsCommand(notificationsCmd);

  // Parent "runs" command with subcommands: list, attach, remove, repair
  const runsCmd = registerRunsCommand(program);
  registerAttachCommand(runsCmd);

  // Parent "git" command with subcommands: cleanup
  registerGitCommand(program);

  return program;
}
