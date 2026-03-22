// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';
import { estimateProject, formatTokenCount, loadTasks, estimateSequentialSeconds, estimateMinutesWithConcurrency } from '../core/estimator.js';
import { loadCalibration, estimateCalibratedMinutes, formatCalibratedTime } from '../core/calibration.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { createMiniRun } from '../utils/run-id.js';
import { createFileLogger, flushFileLogger } from '../utils/logger.js';
import { runWithContext } from '../utils/log-context.js';

export function registerEstimateCommand(program: Command): void {
  program
    .command('estimate')
    .description('Estimate token count and review time via tiktoken (no LLM calls)')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);

      const { runId, logPath } = createMiniRun(projectRoot, 'estimate');
      const runLog = createFileLogger(logPath);

      await runWithContext({ runId, phase: 'estimate' }, async () => {
        runLog.info({ event: 'phase_start', phase: 'estimate', runId }, 'estimate started');
        const startMs = Date.now();

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

        // Calibrated estimate from historical run data
        const calibration = loadCalibration(projectRoot);
        const activeAxes = getEnabledEvaluators(config).map(e => e.id);
        const calibratedMin = estimateCalibratedMinutes(calibration, result.files, activeAxes, concurrency);
        const hasCal = Object.values(calibration.axes).some(a => a.samples > 0);

        const durationMs = Date.now() - startMs;
        runLog.info({
          event: 'phase_end', phase: 'estimate', durationMs,
          files: result.files, symbols: result.symbols,
          inputTokens: result.inputTokens, outputTokens: result.outputTokens,
          estimatedMinutes: minutes,
        }, 'estimate completed');
        flushFileLogger();

        console.log('anatoly — estimate');
        console.log('');
        console.log(`  files        ${result.files}`);
        console.log(`  symbols      ${result.symbols}`);
        console.log(`  est. tokens  ${formatTokenCount(result.inputTokens)} input / ${formatTokenCount(result.outputTokens)} output`);
        const timeLabel = concurrency > 1
          ? `~${minutes} min (×${concurrency})`
          : `~${minutes} min`;
        console.log(`  est. time    ${timeLabel}`);
        const calLabel = hasCal ? 'calibrated' : 'default';
        const calTime = formatCalibratedTime(calibratedMin);
        console.log(`  est. review  ${calTime} (${calLabel}, ${activeAxes.length} axes, ×${concurrency})`);
      });
    });
}
