// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { loadConfig } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';
import { forecastRun, formatTokenCount, loadTasks } from '../core/estimator.js';
import { loadCalibration, formatCalibratedTime } from '../core/calibration.js';
import { ensurePricing } from '../utils/pricing-cache.js';
import { enumerateActiveModels } from '../utils/active-models.js';
import { getLogger } from '../utils/logger.js';
import { getEnabledEvaluators } from '../core/axes/index.js';
import { resolveAxisModel, resolveCodeSummaryModel } from '../core/axis-evaluator.js';
import { triageFile } from '../core/triage.js';
import { buildUsageGraph } from '../core/usage-graph.js';
import { needsBootstrap } from '../core/doc-bootstrap.js';
import { detectProjectProfile, formatLanguageLine, formatFrameworkLine } from '../core/language-detect.js';
import { detectHardware, readEmbeddingsReadyFlag } from '../rag/hardware-detect.js';
import { countChangedDocs } from '../rag/doc-indexer.js';
import { estimateEmbedTokens } from '../rag/embed-estimator.js';
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

      // Hydrate pricing cache before any forecast computation. strict: true so
      // estimate refuses to run with an incomplete pricing table — same rule
      // as `anatoly run` (a $0 forecast for an unpriced model would mislead).
      await ensurePricing(enumerateActiveModels(config), projectRoot, {
        log: (level, message) => getLogger()[level](message),
        strict: true,
      });

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
        { key: 'concurrency', value: `${concurrency} files · ${config.providers.google ? `${config.providers.anthropic?.concurrency ?? 24} Claude + ${config.providers.google.concurrency} Gemini slots` : `${config.providers.anthropic?.concurrency ?? 24} Claude slots`}` },
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
      pipelineRows.push({ phase: 'triage', detail: `${tiers.evaluate} to evaluate (${tiers.skip} skipped)` });

      // rag (merged structural counts: files indexed + functions + chunks)
      let embedForecast: ReturnType<typeof estimateEmbedTokens> | undefined;
      if (enableRag) {
        const ragFiles = allTasks.filter(t =>
          t.symbols.some(s => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
        ).length;
        const docsPath = config.documentation?.docs_path ?? 'docs';
        embedForecast = estimateEmbedTokens(projectRoot, allTasks, [docsPath, join('.anatoly', 'docs')]);
        pipelineRows.push({
          phase: 'rag',
          detail: `${ragFiles} files · ${embedForecast.codeUnits} fns · ${embedForecast.nlpUnits} chunks`,
        });
      }

      // usage graph (kept in the detailed `estimate` view; dropped from the
      // run pre-confirmation table because `15 edges` is opaque to users).
      const usageGraph = buildUsageGraph(projectRoot, allTasks);
      pipelineRows.push({ phase: 'usage graph', detail: `${usageGraph.usages.size} edges` });

      // docs (internal + project merged)
      const bootstrapNeeded = needsBootstrap(projectRoot);
      if (bootstrapNeeded) {
        pipelineRows.push({ phase: 'docs', detail: 'first run (bootstrap)' });
      } else if (docScanInternal) {
        const projectFragment = docScanProject
          ? `project ${docScanProject.changed} changed`
          : 'project deduplicated';
        pipelineRows.push({
          phase: 'docs',
          detail: `${docScanInternal.changed} changed, ${docScanInternal.cached} cached · ${projectFragment}`,
        });
      } else {
        pipelineRows.push({ phase: 'docs', detail: '.anatoly/docs/ ready' });
      }

      // Forecast — decision-grade, cost included, embed tokens surfaced.
      const calibration = loadCalibration(projectRoot);
      const evalTasks = allTasks.filter(t => {
        try {
          const source = readFileSync(resolve(projectRoot, t.file), 'utf-8');
          return triageFile(t, source).tier === 'evaluate';
        } catch {
          return true; // unreadable file: treat as evaluate (matches triage fallback)
        }
      });
      const forecast = forecastRun({
        projectRoot,
        evalTasks,
        totalFiles: allTasks.length,
        axes: evaluators.map(e => ({ id: e.id, model: resolveAxisModel(e, config) })),
        ...(embedForecast ? { embed: embedForecast } : {}),
        ...(enableRag ? { summaryModel: resolveCodeSummaryModel(config) } : {}),
        calibration,
        concurrency,
        ragEnabled: enableRag,
        deliberation: true,
      });
      const calLabel = forecast.hasCalibration ? 'calibrated' : 'default';

      // Forecast block (estimate command only — verdict before pipeline detail).
      const totalTokensFragment = `${formatTokenCount(forecast.llm.inputTokens)} in / ${formatTokenCount(forecast.llm.outputTokens)} out`
        + (forecast.embed.tokens > 0 ? ` + ${formatTokenCount(forecast.embed.tokens)} embed` : '');
      const costBreakdown = Object.entries(forecast.llm.costByModel)
        .filter(([, c]) => c > 0)
        .map(([m, c]) => `$${c.toFixed(2)} ${m}`)
        .join(' · ');
      const costFragment = costBreakdown
        ? `$${forecast.totalCostUsd.toFixed(2)}  (${costBreakdown})`
        : `$${forecast.totalCostUsd.toFixed(2)}`;
      const filesFragment = forecast.skippedFiles > 0
        ? `${forecast.files} of ${forecast.totalFiles}  (${forecast.skippedFiles} skipped by triage)`
        : `${forecast.files} files`;
      const forecastRows = [
        { key: 'files', value: filesFragment },
        { key: 'tokens', value: totalTokensFragment },
        { key: 'cost', value: costFragment },
        { key: 'time', value: `${formatCalibratedTime(forecast.calibratedMin)}  (${calLabel})` },
      ];

      renderSetupTable(
        { project: projectInfo, config: configRows, models: modelsLeft, modelsRight, forecast: forecastRows, pipeline: pipelineRows },
        false,
      );
    });
}
