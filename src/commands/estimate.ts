// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';
import { estimateTasksTokens, formatTokenCount, loadTasks } from '../core/estimator.js';
import { loadCalibration, estimateCalibratedMinutes, formatCalibratedTime } from '../core/calibration.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { resolveAxisModel } from '../core/axis-evaluator.js';
import { triageFile } from '../core/triage.js';
import { buildUsageGraph } from '../core/usage-graph.js';
import { needsBootstrap } from '../core/doc-bootstrap.js';
import { detectProjectProfile, formatLanguageLine, formatFrameworkLine } from '../core/language-detect.js';
import { detectHardware, readEmbeddingsReadyFlag } from '../rag/hardware-detect.js';
import { printBanner } from '../utils/banner.js';
import { renderSetupTable, shortModelName } from '../cli/setup-table.js';

export function registerEstimateCommand(program: Command): void {
  program
    .command('estimate')
    .description('Show the startup summary table (no LLM calls)')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);
      const concurrency = config.llm.concurrency;

      printBanner();

      // Auto-scan if no tasks directory exists
      const tasksDir = resolve(projectRoot, '.anatoly', 'tasks');
      if (!existsSync(tasksDir)) {
        await scanProject(projectRoot, config);
      }

      // --- Project info ---
      let projectInfo: { name: string; version: string; languages?: string; frameworks?: string } | undefined;
      try {
        const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
        if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
          projectInfo = { name: pkg.name, version: pkg.version };
        }
      } catch { /* no package.json */ }

      const profile = detectProjectProfile(projectRoot);
      const langLine = formatLanguageLine(profile.languages.languages);
      const fwLine = formatFrameworkLine(profile.frameworks);
      if (!projectInfo && (langLine || fwLine)) {
        projectInfo = { name: basename(projectRoot), version: '\u2014' };
      }
      if (projectInfo) {
        if (langLine) projectInfo.languages = langLine;
        if (fwLine) projectInfo.frameworks = fwLine;
      }

      // --- Config rows ---
      const enableRag = config.rag.enabled;
      let ragLabel = 'off';
      if (enableRag) {
        const hardware = detectHardware();
        const embeddingsReady = readEmbeddingsReadyFlag(projectRoot);
        const canAdvanced = hardware.hasGpu && embeddingsReady !== null;
        const needsSidecar = canAdvanced && config.rag.code_model === 'auto';
        const resolvedRagMode = needsSidecar ? 'advanced' : 'lite';
        ragLabel = resolvedRagMode === 'advanced'
          ? 'advanced — code: nomic-7B / nlp: Qwen3-8B'
          : 'lite — code: jina-v2 / nlp: MiniLM';
      }

      const configRows = [
        { key: 'concurrency', value: `${concurrency} files · ${config.llm.sdk_concurrency} SDK slots` },
        { key: 'rag', value: ragLabel },
        { key: 'cache', value: 'on' },
      ];

      // --- Axes rows ---
      const evaluators = getEnabledEvaluators(config);
      const axesRows = evaluators.map(e => ({
        key: e.id as string,
        value: shortModelName(resolveAxisModel(e, config)),
      }));

      // --- Pipeline rows ---
      const pipelineRows: { phase: string; detail: string }[] = [];
      const allTasks = loadTasks(projectRoot);

      // scan
      pipelineRows.push({ phase: 'scan', detail: `${allTasks.length} files` });

      // triage
      const tiers = { skip: 0, evaluate: 0 };
      for (const task of allTasks) {
        const absPath = resolve(projectRoot, task.file);
        let source: string;
        try { source = readFileSync(absPath, 'utf-8'); } catch { tiers.evaluate++; continue; }
        const result = triageFile(task, source);
        tiers[result.tier]++;
      }
      pipelineRows.push({ phase: 'triage', detail: `${tiers.skip} skip · ${tiers.evaluate} evaluate` });

      // rag
      if (enableRag) {
        const ragFiles = allTasks.filter(t =>
          t.symbols.some(s => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
        ).length;
        pipelineRows.push({ phase: 'rag', detail: `${ragFiles} files` });
      }

      // usage graph
      const usageGraph = buildUsageGraph(projectRoot, allTasks);
      pipelineRows.push({ phase: 'usage graph', detail: `${usageGraph.usages.size} edges` });

      // internal docs
      const bootstrapNeeded = needsBootstrap(projectRoot);
      pipelineRows.push({
        phase: 'internal docs',
        detail: bootstrapNeeded ? 'first run (bootstrap)' : '.anatoly/docs/ ready',
      });

      // estimate (with calibrated ETA)
      const { inputTokens, outputTokens } = estimateTasksTokens(projectRoot, allTasks);
      const calibration = loadCalibration(projectRoot);
      const activeAxes = evaluators.map(e => e.id);
      const evalFileCount = tiers.evaluate;
      const calibratedMin = estimateCalibratedMinutes(calibration, evalFileCount, activeAxes, concurrency);
      const hasCal = Object.values(calibration.axes).some(a => a.samples > 0);
      const calLabel = hasCal ? 'calibrated' : 'default';
      const tokenLabel = `${allTasks.length} files · ${formatTokenCount(inputTokens + outputTokens)} tokens`;
      pipelineRows.push({ phase: 'estimate', detail: `${tokenLabel} · ${formatCalibratedTime(calibratedMin)} (${calLabel})` });

      renderSetupTable({ project: projectInfo, config: configRows, axes: axesRows, pipeline: pipelineRows }, false);
    });
}
