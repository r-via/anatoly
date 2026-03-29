// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';
import { estimateTasksTokens, formatTokenCount, loadTasks } from '../core/estimator.js';
import { loadCalibration, estimateCalibratedMinutes, formatCalibratedTime } from '../core/calibration.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { resolveAxisModel, resolveCodeSummaryModel } from '../core/axis-evaluator.js';
import { triageFile } from '../core/triage.js';
import { buildUsageGraph } from '../core/usage-graph.js';
import { needsBootstrap } from '../core/doc-bootstrap.js';
import { detectProjectProfile, formatLanguageLine, formatFrameworkLine } from '../core/language-detect.js';
import { detectHardware, readEmbeddingsReadyFlag } from '../rag/hardware-detect.js';
import { countChangedDocs } from '../rag/doc-indexer.js';
import { readProgress } from '../utils/cache.js';
import { printBanner } from '../utils/banner.js';
import { renderSetupTable, shortModelName } from '../cli/setup-table.js';

/** Registers the `estimate` CLI sub-command on the given Commander program. @param program The root Commander instance. */
export function registerEstimateCommand(program: Command): void {
  program
    .command('estimate')
    .description('Show the startup summary table (no LLM calls)')
    .action(async () => {
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);
      const concurrency = config.runtime.concurrency;

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
      let resolvedRagSuffix: 'lite' | 'advanced' = 'lite';
      if (enableRag) {
        const hardware = detectHardware();
        const embeddingsReady = readEmbeddingsReadyFlag(projectRoot);
        const canAdvanced = hardware.hasGpu && embeddingsReady !== null;
        const needsSidecar = canAdvanced && config.rag.code_model === 'auto';
        resolvedRagSuffix = needsSidecar ? 'advanced' : 'lite';
        ragLabel = resolvedRagSuffix;
      }

      const configRows = [
        { key: 'concurrency', value: `${concurrency} files · ${config.providers.google ? `${config.providers.anthropic.concurrency} Claude + ${config.providers.google.concurrency} Gemini slots` : `${config.providers.anthropic.concurrency} Claude slots`}` },
        { key: 'rag', value: ragLabel },
        { key: 'cache', value: 'on' },
      ];

      // --- Models rows (left: axes, right: embeddings/chunking/summarization) ---
      const evaluators = getEnabledEvaluators(config);
      const modelsLeft = evaluators.map(e => ({
        key: e.id as string,
        value: shortModelName(resolveAxisModel(e, config)),
      }));
      const modelsRight: { key: string; value: string }[] = [];
      if (enableRag) {
        if (resolvedRagSuffix === 'advanced') {
          modelsRight.push({ key: 'embeddings/code', value: 'nomic-embed-code Q5_K_M' });
          modelsRight.push({ key: 'embeddings/nlp', value: 'Qwen3-8B Q5_K_M' });
        } else {
          modelsRight.push({ key: 'embeddings/code', value: 'jina-v2 768d' });
          modelsRight.push({ key: 'embeddings/nlp', value: 'MiniLM-L6 384d' });
        }
        modelsRight.push({ key: 'chunking', value: 'smartChunkDoc (no LLM)' });
        modelsRight.push({ key: 'summarization', value: shortModelName(resolveCodeSummaryModel(config)) });
      }

      // --- Pipeline rows ---
      const pipelineRows: { phase: string; detail: string }[] = [];
      const allTasks = loadTasks(projectRoot);

      // scan
      const progressPath = resolve(projectRoot, '.anatoly', 'cache', 'progress.json');
      const progress = readProgress(progressPath);
      let scanDetail = `${allTasks.length} files`;
      if (progress) {
        // Count how many current tasks have a cached/done progress entry
        const cached = allTasks.filter(t => {
          const entry = progress.files[t.file];
          return entry && (entry.status === 'CACHED' || entry.status === 'DONE');
        }).length;
        const pending = allTasks.length - cached;
        scanDetail = `${allTasks.length} files (${pending} new, ${cached} cached)`;
      }
      pipelineRows.push({ phase: 'source files', detail: scanDetail });
      let docScanProject: ReturnType<typeof countChangedDocs> = null;
      let docScanInternal: ReturnType<typeof countChangedDocs> = null;
      if (enableRag) {
        const ragSuffix = resolvedRagSuffix;
        const docsPath = config.documentation?.docs_path ?? 'docs';
        docScanProject = countChangedDocs(projectRoot, docsPath, ragSuffix);
        docScanInternal = countChangedDocs(projectRoot, join('.anatoly', 'docs'), `${ragSuffix}-internal`);
      }

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
      if (bootstrapNeeded) {
        pipelineRows.push({ phase: 'internal docs', detail: 'first run (bootstrap)' });
      } else if (docScanInternal) {
        pipelineRows.push({ phase: 'internal docs', detail: `${docScanInternal.changed} changed, ${docScanInternal.cached} cached` });
        if (docScanProject) {
          pipelineRows.push({ phase: 'project docs', detail: `${docScanProject.changed} changed, ${docScanProject.cached} cached` });
        } else {
          pipelineRows.push({ phase: 'project docs', detail: 'deduplicated from internal' });
        }
      } else {
        pipelineRows.push({ phase: 'internal docs', detail: '.anatoly/docs/ ready' });
      }

      // estimate (with calibrated ETA)
      const { inputTokens, outputTokens } = estimateTasksTokens(projectRoot, allTasks);
      const calibration = loadCalibration(projectRoot);
      const activeAxes = evaluators.map(e => e.id);
      const evalFileCount = tiers.evaluate;
      const calibratedMin = estimateCalibratedMinutes(calibration, evalFileCount, activeAxes, concurrency);
      const hasCal = Object.values(calibration.axes).some(a => a.samples > 0);
      const calLabel = hasCal ? 'calibrated' : 'default';
      const tokenLabel = `${evalFileCount} files · ${formatTokenCount(inputTokens + outputTokens)} tokens`;
      pipelineRows.push({ phase: 'estimate', detail: `${tokenLabel} · ${formatCalibratedTime(calibratedMin)} (${calLabel})` });

      renderSetupTable({ project: projectInfo, config: configRows, models: modelsLeft, modelsRight, pipeline: pipelineRows }, false);
    });
}
