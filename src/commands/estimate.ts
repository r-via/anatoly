// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { loadConfig, getV3Source } from '../utils/config-loader.js';
import { scanProject } from '../core/scanner.js';
import { forecastRun, formatTokenCount, loadTasks, FORECAST_STEP_CATEGORY_ORDER, type ForecastStep } from '../core/estimator.js';
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
import { detectHardware, readEmbeddingsReadyFlag, resolveEmbeddingModels, type ResolvedModels } from '../rag/hardware-detect.js';
import { countChangedDocs } from '../rag/doc-indexer.js';
import { estimateEmbedTokens } from '../rag/embed-estimator.js';
import { readProgress } from '../utils/cache.js';
import { printBanner } from '../utils/banner.js';
import { shortModelName } from '../cli/setup-table.js';
import chalk from 'chalk';
import Table from 'cli-table3';

/** Strip provider prefix and `claude-` prefix for compact model display. */
function displayModel(modelId: string): string {
  if (modelId === 'local') return '(local)';
  return modelId.replace(/^[^/]+\//, '').replace(/^claude-/, '');
}

/**
 * Sort steps for the breakdown view: group by category in the canonical
 * order (axis → summary → embed → doc), then by costUsd desc within each
 * group so the biggest contributors of each kind appear first.
 */
function sortSteps(steps: ForecastStep[]): ForecastStep[] {
  return [...steps].sort((a, b) => {
    const ca = FORECAST_STEP_CATEGORY_ORDER.indexOf(a.category);
    const cb = FORECAST_STEP_CATEGORY_ORDER.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return b.costUsd - a.costUsd;
  });
}

// ---------------------------------------------------------------------------
// Estimate view rendering — uses cli-table3 throughout (only path; the run
// pre-confirmation table keeps its own renderSetupTable in cli/setup-table.ts).
// ---------------------------------------------------------------------------

/**
 * cli-table3 chars used by every estimate-view section. Same convention as
 * `formatProvidersTable` in providers.ts:
 *   - no outer top/bottom borders (sections have their own colored title above)
 *   - 2-space left indent so content sits inside the visual margin
 *   - single horizontal line as inter-row separator (`mid: '─'`)
 *   - 3-space inter-column gap (`middle: '   '`) for breathing room
 */
const KV_CHARS = {
  top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
  bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
  left: '  ', 'left-mid': '  ',
  mid: '─', 'mid-mid': ' ',
  right: '', 'right-mid': '',
  middle: '   ',
};

function newKvTable(opts?: { colAligns?: ('left' | 'center' | 'right')[]; head?: string[] }): InstanceType<typeof Table> {
  return new Table({
    chars: KV_CHARS,
    style: { 'padding-left': 0, 'padding-right': 0, head: ['dim'] },
    ...(opts?.colAligns ? { colAligns: opts.colAligns } : {}),
    ...(opts?.head ? { head: opts.head } : {}),
  });
}

function printSection(title: string, color: (s: string) => string, body: string): void {
  console.log('');
  console.log('  ' + color(title));
  console.log(body);
}

interface EstimateViewData {
  project?: { name: string; version: string; languages?: string; frameworks?: string };
  config: { key: string; value: string }[];
  models: { key: string; value: string }[];
  modelsRight?: { key: string; value: string }[];
  forecast: {
    filesValue: string;
    tokensValue: string;
    totalCostUsd: number;
    timeValue: string;
    steps: ForecastStep[];
  };
  pipeline: { phase: string; detail: string }[];
}

function renderEstimateView(data: EstimateViewData): void {
  // --- Project Info ---
  if (data.project) {
    const t = newKvTable();
    t.push(['name', data.project.name]);
    t.push(['version', data.project.version]);
    if (data.project.languages) t.push(['languages', data.project.languages]);
    if (data.project.frameworks) t.push(['frameworks', data.project.frameworks]);
    printSection('Project Info', chalk.green.bold, t.toString());
  }

  // --- Configuration ---
  {
    const t = newKvTable();
    for (const r of data.config) t.push([r.key, r.value]);
    printSection('Configuration', chalk.cyan.bold, t.toString());
  }

  // --- Used Models (4 cols: key1, val1, key2, val2) ---
  {
    const t = newKvTable();
    const max = Math.max(data.models.length, data.modelsRight?.length ?? 0);
    const hasRight = (data.modelsRight?.length ?? 0) > 0;
    for (let i = 0; i < max; i++) {
      const l = data.models[i];
      const r = data.modelsRight?.[i];
      const row = [l?.key ?? '', l?.value ?? ''];
      if (hasRight) row.push(r?.key ?? '', r?.value ?? '');
      t.push(row);
    }
    printSection('Used Models', chalk.magenta.bold, t.toString());
  }

  // --- Forecast (decision-grade headlines: files / tokens / cost / time) ---
  {
    const t = newKvTable();
    t.push(['files', data.forecast.filesValue]);
    t.push(['tokens', data.forecast.tokensValue]);
    t.push(['cost', `$${data.forecast.totalCostUsd.toFixed(2)} total`]);
    t.push(['time', data.forecast.timeValue]);
    printSection('Forecast', chalk.yellow.bold, t.toString());
  }

  // --- Cost breakdown — 4 columns: category, step name, cost (right-aligned), model.
  // Sorted: axis → summary → embed → doc, then by cost desc within each group.
  {
    const sorted = sortSteps(data.forecast.steps);
    const t = newKvTable({
      head: ['category', 'step', 'cost', 'model'],
      colAligns: ['left', 'left', 'right', 'left'],
    });
    for (const s of sorted) {
      const cost = (s.approximate ? '~' : '') + '$' + s.costUsd.toFixed(2);
      t.push([s.category, s.name, cost, displayModel(s.model)]);
    }
    printSection('Cost breakdown', chalk.yellow.bold, t.toString());
  }

  // --- Pipeline Plan ---
  {
    const t = newKvTable();
    for (const r of data.pipeline) t.push([chalk.green('✔') + ' ' + r.phase, r.detail]);
    printSection('Pipeline Plan', chalk.blue.bold, t.toString());
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// JSON payload — versioned shape for `--json` mode (machine-readable).
// ---------------------------------------------------------------------------

const ESTIMATE_SCHEMA_VERSION = 1 as const;

/** Public JSON shape returned by `anatoly estimate --json`. Stable within a `schemaVersion`. */
interface EstimateJsonPayload {
  schemaVersion: typeof ESTIMATE_SCHEMA_VERSION;
  /** ISO-8601 timestamp of when this estimate was produced. */
  timestamp: string;
  project?: {
    name: string;
    version: string;
    languages?: string;
    frameworks?: string;
  };
  config: {
    concurrency: number;
    ragEnabled: boolean;
    ragMode: 'off' | 'lite' | 'advanced' | 'external';
    cache: boolean;
  };
  models: {
    axes: Record<string, string>;
    summarization?: string;
    embeddings?: { code: string; nlp: string; backend: 'lite' | 'advanced-gguf' | 'external' };
  };
  forecast: {
    files: { total: number; evaluate: number; skipped: number };
    tokens: {
      llm: { inputTokens: number; outputTokens: number };
      embed: { tokens: number; codeUnits: number; nlpUnits: number };
      total: number;
    };
    cost: {
      totalUsd: number;
      llmUsd: number;
      embedUsd: number;
      byModel: Record<string, number>;
    };
    time: { minutes: number; calibrated: boolean };
    steps: ForecastStep[];
  };
  plan: {
    scan: { totalFiles: number; new: number; cached: number };
    triage: { evaluate: number; skipped: number };
    rag?: { files: number; codeUnits: number; nlpUnits: number };
    usageGraph: { edges: number };
    docs: {
      mode: 'bootstrap' | 'update' | 'ready';
      internal?: { changed: number; cached: number };
      project?: { changed: number; cached: number };
    };
  };
}

/** Registers the `estimate` CLI sub-command on the given Commander program. @param program The root Commander instance. */
export function registerEstimateCommand(program: Command): void {
  program
    .command('estimate')
    .description('Show the startup summary table (no LLM calls)')
    .option('--json', 'emit a machine-readable JSON payload to stdout instead of the rendered table (logs go to stderr)')
    .action(async (cmdOpts: { json?: boolean }) => {
      const jsonMode = cmdOpts.json === true;
      const projectRoot = resolve('.');
      const parentOpts = program.opts();
      const config = loadConfig(projectRoot, parentOpts.config as string | undefined);
      const concurrency = config.runtime.concurrency;

      // Resolve the embedding tier eagerly so the active-models list passed
      // to the pricing gate includes any external SDK models the user only
      // identified by `provider` (no explicit `model` in `.anatoly.yml`).
      // For local tiers (ONNX / GGUF) the runtime is non-`sdk`, the resolved
      // ids stay out of the active list, and pricing isn't required.
      let resolvedEmbed: ResolvedModels | undefined;
      if (config.rag.enabled) {
        const hardware = detectHardware();
        const readyFlag = readEmbeddingsReadyFlag(projectRoot);
        resolvedEmbed = await resolveEmbeddingModels(config.rag, hardware, undefined, readyFlag, getV3Source(config));
      }

      // Augment active models for the pricing gate ONLY when the resolved
      // backend is 'external' (third-party SDK with per-token billing).
      // 'lite' (ONNX) and 'advanced-gguf' (anatoly-local Docker) are local —
      // their model ids are absent from upstream pricing registries by design,
      // so adding them here would falsely trigger PRICING_INCOMPLETE.
      const activeModels = enumerateActiveModels(config);
      if (resolvedEmbed?.backend === 'external') {
        activeModels.push(resolvedEmbed.codeModel, resolvedEmbed.nlpModel);
      }

      // Hydrate pricing cache before any forecast computation. strict: true so
      // estimate refuses to run with an incomplete pricing table — same rule
      // as `anatoly run` (a $0 forecast for an unpriced model would mislead).
      await ensurePricing([...new Set(activeModels)], projectRoot, {
        log: (level, message) => getLogger()[level](message),
        strict: true,
      });

      // Banner is purely decorative — suppress in --json mode so stdout
      // contains only the JSON payload (logs already go to stderr via pino).
      if (!jsonMode) printBanner();

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
      // Only attach embedding model ids when the resolved backend is
      // 'external' — local backends have no API price, so passing their ids
      // would just hit a missing-pricing path that returns 0 anyway.
      const externalEmbed = resolvedEmbed?.backend === 'external' ? resolvedEmbed : undefined;
      const embedWithModels = embedForecast
        ? {
            ...embedForecast,
            ...(externalEmbed ? { codeModel: externalEmbed.codeModel, nlpModel: externalEmbed.nlpModel } : {}),
          }
        : undefined;
      // Doc-gen forecast: pick mode + page count for the heuristic.
      // Bootstrap page count is approximated from project size (no canonical
      // value exists pre-pipeline). Update uses the actual changed count.
      const docMode: 'bootstrap' | 'update' = bootstrapNeeded ? 'bootstrap' : 'update';
      const docPageCount = docMode === 'bootstrap'
        ? Math.max(8, Math.ceil(allTasks.length / 12))
        : (docScanInternal?.changed ?? 0);
      const scaffoldingModel = config.agents.scaffolding ?? config.models.quality;

      const forecast = forecastRun({
        projectRoot,
        evalTasks,
        totalFiles: allTasks.length,
        axes: evaluators.map(e => ({ id: e.id, model: resolveAxisModel(e, config) })),
        ...(embedWithModels ? { embed: embedWithModels } : {}),
        ...(enableRag ? { summaryModel: resolveCodeSummaryModel(config) } : {}),
        ...(docPageCount > 0
          ? { docContext: { mode: docMode, pageCount: docPageCount, scaffoldingModel } }
          : {}),
        calibration,
        concurrency,
        ragEnabled: enableRag,
        deliberation: true,
      });
      const calLabel = forecast.hasCalibration ? 'calibrated' : 'default';

      // --- JSON mode: emit a versioned payload, skip the rendered view. ---
      if (jsonMode) {
        const docsMode: 'bootstrap' | 'update' | 'ready' = bootstrapNeeded
          ? 'bootstrap'
          : (docScanInternal?.changed ?? 0) > 0 ? 'update' : 'ready';
        const payload: EstimateJsonPayload = {
          schemaVersion: ESTIMATE_SCHEMA_VERSION,
          timestamp: new Date().toISOString(),
          ...(projectInfo ? { project: projectInfo } : {}),
          config: {
            concurrency,
            ragEnabled: enableRag,
            ragMode: enableRag ? (resolvedEmbed?.backend ?? 'lite') as EstimateJsonPayload['config']['ragMode'] : 'off',
            cache: true,
          },
          models: {
            axes: Object.fromEntries(evaluators.map(e => [e.id, resolveAxisModel(e, config)])),
            ...(enableRag ? { summarization: resolveCodeSummaryModel(config) } : {}),
            ...(resolvedEmbed
              ? {
                  embeddings: {
                    code: resolvedEmbed.codeModel,
                    nlp: resolvedEmbed.nlpModel,
                    // 'advanced-fp16' is a deprecated runtime value that the SDK
                    // collapses to 'lite' at runtime — do the same in the API.
                    backend: resolvedEmbed.backend === 'advanced-fp16' ? 'lite' : resolvedEmbed.backend,
                  },
                }
              : {}),
          },
          forecast: {
            files: { total: forecast.totalFiles, evaluate: forecast.files, skipped: forecast.skippedFiles },
            tokens: {
              llm: { inputTokens: forecast.llm.inputTokens, outputTokens: forecast.llm.outputTokens },
              embed: { tokens: forecast.embed.tokens, codeUnits: forecast.embed.codeUnits, nlpUnits: forecast.embed.nlpUnits },
              total: forecast.totalTokens,
            },
            cost: {
              totalUsd: forecast.totalCostUsd,
              llmUsd: forecast.llm.costUsd,
              embedUsd: forecast.embed.costUsd,
              byModel: forecast.llm.costByModel,
            },
            time: { minutes: forecast.calibratedMin, calibrated: forecast.hasCalibration },
            steps: sortSteps(forecast.steps),
          },
          plan: {
            scan: (() => {
              const cached = progress
                ? allTasks.filter(t => {
                    const e = progress.files[t.file];
                    return e && (e.status === 'CACHED' || e.status === 'DONE');
                  }).length
                : 0;
              return { totalFiles: allTasks.length, new: allTasks.length - cached, cached };
            })(),
            triage: { evaluate: tiers.evaluate, skipped: tiers.skip },
            ...(enableRag && embedForecast
              ? {
                  rag: {
                    files: allTasks.filter(t =>
                      t.symbols.some(s => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
                    ).length,
                    codeUnits: embedForecast.codeUnits,
                    nlpUnits: embedForecast.nlpUnits,
                  },
                }
              : {}),
            usageGraph: { edges: usageGraph.usages.size },
            docs: {
              mode: docsMode,
              ...(docScanInternal ? { internal: { changed: docScanInternal.changed, cached: docScanInternal.cached } } : {}),
              ...(docScanProject ? { project: { changed: docScanProject.changed, cached: docScanProject.cached } } : {}),
            },
          },
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        return;
      }

      // Forecast block (estimate command only — verdict before pipeline detail).
      const totalTokensFragment = `${formatTokenCount(forecast.llm.inputTokens)} in / ${formatTokenCount(forecast.llm.outputTokens)} out`
        + (forecast.embed.tokens > 0 ? ` + ${formatTokenCount(forecast.embed.tokens)} embed` : '');
      const filesFragment = forecast.skippedFiles > 0
        ? `${forecast.files} of ${forecast.totalFiles}  (${forecast.skippedFiles} skipped by triage)`
        : `${forecast.files} files`;

      renderEstimateView({
        project: projectInfo,
        config: configRows,
        models: modelsLeft,
        modelsRight,
        forecast: {
          filesValue: filesFragment,
          tokensValue: totalTokensFragment,
          totalCostUsd: forecast.totalCostUsd,
          timeValue: `${formatCalibratedTime(forecast.calibratedMin)}  (${calLabel})`,
          steps: forecast.steps,
        },
        pipeline: pipelineRows,
      });
    });
}
