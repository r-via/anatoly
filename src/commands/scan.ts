// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';
import { createMiniRun } from '../utils/run-id.js';
import { createFileLogger, flushFileLogger } from '../utils/logger.js';
import { runWithContext } from '../utils/log-context.js';

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Parse AST and compute SHA-256 hashes for all TypeScript files')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      const { runId, logPath } = createMiniRun(projectRoot, 'scan');
      const runLog = createFileLogger(logPath);

      await runWithContext({ runId, phase: 'scan' }, async () => {
        runLog.info({ event: 'phase_start', phase: 'scan', runId }, 'scan started');
        const startMs = Date.now();

        const result = await scanProject(projectRoot, config);

        const durationMs = Date.now() - startMs;
        runLog.info({
          event: 'phase_end', phase: 'scan', durationMs,
          filesScanned: result.filesScanned, filesNew: result.filesNew, filesCached: result.filesCached,
        }, 'scan completed');
        flushFileLogger();

        console.log('anatoly — scan');
        console.log(`  files     ${result.filesScanned}`);
        console.log(`  new       ${result.filesNew}`);
        console.log(`  cached    ${result.filesCached}`);
      });
    });
}
