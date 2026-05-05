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
import { shortModelName } from '../cli/setup-table.js';
import chalk from 'chalk';
import Table from 'cli-table3';

/** Strip provider prefix, `claude-` prefix, and trailing 8-digit date for compact model display. */
function displayModel(modelId: string): string {
  if (modelId === 'local') return '(local)';
  return modelId
    .replace(/^[^/]+\//, '')   // strip provider prefix (e.g. "anthropic/")
    .replace(/^claude-/, '')   // strip "claude-" prefix
    .replace(/-\d{8}$/, '');   // strip trailing -YYYYMMDD release date
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
 * Two cli-table3 char sets used by the estimate view:
 *
 *   - `KV_NO_SEP_CHARS`: no inter-row separator, used for blocks rendered as
 *     a single multi-line cli-table3 row (key/value pairs joined by `\n`).
 *     Avoids the noisy `─` line between every entry in 3-4-row kv sections.
 *
 *   - `TABLE_CHARS`: visible `─` separator between rows. Used only for truly
 *     tabular sections (Cost breakdown sub-tables, Pipeline Plan) where the
 *     separator helps the eye scan rows.
 *
 * Both share: no top/bottom borders, 2-space left indent, 3-space inter-column gap.
 */
const KV_NO_SEP_CHARS = {
  top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
  bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
  left: '  ', 'left-mid': '',
  mid: '', 'mid-mid': '',
  right: '', 'right-mid': '',
  middle: '   ',
};

const TABLE_CHARS = {
  top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
  bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
  left: '  ', 'left-mid': '  ',
  mid: '─', 'mid-mid': ' ',
  right: '', 'right-mid': '',
  middle: '   ',
};

function newTable(opts?: {
  chars?: typeof KV_NO_SEP_CHARS;
  colAligns?: ('left' | 'center' | 'right')[];
  head?: string[];
}): InstanceType<typeof Table> {
  return new Table({
    chars: opts?.chars ?? KV_NO_SEP_CHARS,
    style: { 'padding-left': 0, 'padding-right': 0, head: ['dim'] },
    ...(opts?.colAligns ? { colAligns: opts.colAligns } : {}),
    ...(opts?.head ? { head: opts.head } : {}),
  });
}

/**
 * Render a key/value block without inter-row separators. Uses the cli-table3
 * "single multi-line row" trick: the keys are joined by `\n` into one cell,
 * the values likewise. cli-table3 then aligns the columns by the longest
 * line in each, but only emits one row of output → zero `─` separators.
 */
function makeKvBlock(rows: ReadonlyArray<{ key: string; value: string }>): string {
  if (rows.length === 0) return '';
  const t = newTable();
  t.push([rows.map((r) => r.key).join('\n'), rows.map((r) => r.value).join('\n')]);
  return t.toString();
}

/** Print a section title with a dim rule under it for visual hierarchy. */
function printSection(title: string, color: (s: string) => string, body: string): void {
  console.log('');
  console.log('  ' + color(title));
  console.log('  ' + chalk.dim('─'.repeat(Math.max(title.length, 14))));
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
}

function renderEstimateView(data: EstimateViewData): void {
  // Reading order is bottom-up — CLI users land on the LAST line of the
  // output (next to the prompt that comes back). So we build context first,
  // then the breakdown, and end on the Forecast: the headline `cost / time`
  // sits right above the prompt and is what the eye remembers.

  // --- Project Info — kv block, no separators ---
  if (data.project) {
    const rows = [
      { key: 'name', value: data.project.name },
      { key: 'version', value: data.project.version },
      ...(data.project.languages ? [{ key: 'languages', value: data.project.languages }] : []),
      ...(data.project.frameworks ? [{ key: 'frameworks', value: data.project.frameworks }] : []),
    ];
    printSection('Project Info', chalk.green.bold, makeKvBlock(rows));
  }

  // --- Configuration ---
  printSection('Configuration', chalk.cyan.bold, makeKvBlock(data.config));

  // --- Used Models — two stacked sub-blocks (axes / rag). ---
  {
    console.log('');
    console.log('  ' + chalk.magenta.bold('Used Models'));
    console.log('  ' + chalk.dim('─'.repeat(14)));
    if (data.models.length > 0) {
      console.log('');
      console.log('  ' + chalk.dim('axes'));
      console.log(makeKvBlock(data.models));
    }
    if (data.modelsRight && data.modelsRight.length > 0) {
      console.log('');
      console.log('  ' + chalk.dim('rag'));
      console.log(makeKvBlock(data.modelsRight));
    }
  }

  // --- Cost breakdown — per-step contributions building up to the total ---
  {
    console.log('');
    console.log('  ' + chalk.yellow.bold('Cost breakdown'));
    console.log('  ' + chalk.dim('─'.repeat(14)));

    const sorted = sortSteps(data.forecast.steps);
    const groups = new Map<string, ForecastStep[]>();
    for (const s of sorted) {
      if (!groups.has(s.category)) groups.set(s.category, []);
      groups.get(s.category)!.push(s);
    }

    for (const [category, items] of groups) {
      console.log('');
      // Single-entry category with no sub-name (e.g. summary, deliberation)
      // reads better inline: the category title carries the cost+model
      // directly, no empty-name placeholder row needed.
      const isSingleton = items.length === 1 && items[0].name === '';
      if (isSingleton) {
        const s = items[0];
        const cost = (s.approximate ? '~' : '') + '$' + s.costUsd.toFixed(2);
        const t = newTable({ colAligns: ['left', 'right', 'left'] });
        t.push([chalk.dim(category), cost, displayModel(s.model)]);
        console.log(t.toString());
        continue;
      }
      console.log('  ' + chalk.dim(category));
      const t = newTable({ colAligns: ['left', 'right', 'left'] });
      const names = items.map((s) => s.name).join('\n');
      const costs = items.map((s) => (s.approximate ? '~' : '') + '$' + s.costUsd.toFixed(2)).join('\n');
      const models = items.map((s) => displayModel(s.model)).join('\n');
      t.push([names, costs, models]);
      console.log(t.toString());
    }
  }

  // --- Forecast — the verdict, last so the user's eye lands on it.
  // The cost value is bold so it pops as the headline number. ---
  {
    const rows = [
      { key: 'files', value: data.forecast.filesValue },
      { key: 'tokens', value: data.forecast.tokensValue },
      { key: 'cost', value: chalk.yellow.bold(`$${data.forecast.totalCostUsd.toFixed(2)} total`) },
      { key: 'time', value: data.forecast.timeValue },
    ];
    printSection('Forecast', chalk.yellow.bold, makeKvBlock(rows));
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

      // No banner: `estimate` is a pure forecast view — the ASCII banner
      // adds vertical noise above the actually useful content. (Banner stays
      // on `anatoly run` where it marks the start of a long-running session.)

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

      // Configuration rows are populated incrementally below — the rag /
      // docs lines are enriched with the RAG indexing scope + doc-bootstrap
      // status, so what was previously two sections (Configuration +
      // Pipeline Plan) collapses into one semantic block: "what's set up
      // for this run". The rest of the diagnostic info is in the JSON payload.
      const configRows: { key: string; value: string }[] = [
        { key: 'concurrency', value: `${concurrency} files · ${config.providers.google ? `${config.providers.anthropic?.concurrency ?? 24} Claude + ${config.providers.google.concurrency} Gemini slots` : `${config.providers.anthropic?.concurrency ?? 24} Claude slots`}` },
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
          modelsRight.push({ key: 'code', value: 'nomic-embed-code Q5_K_M' });
          modelsRight.push({ key: 'text', value: 'Qwen3-8B Q5_K_M' });
        } else {
          modelsRight.push({ key: 'code', value: 'jina-v2 768d' });
          modelsRight.push({ key: 'text', value: 'MiniLM-L6 384d' });
        }
        modelsRight.push({ key: 'chunking', value: 'smartChunkDoc (no LLM)' });
        modelsRight.push({ key: 'summarization', value: shortModelName(resolveCodeSummaryModel(config)) });
      }

      const allTasks = loadTasks(projectRoot);

      // Cached/new file counts — surfaced in the JSON payload's plan.scan
      // section. Not rendered as a pipeline row (the total file count is
      // already in the Forecast `files` line).
      const progressPath = resolve(projectRoot, '.anatoly', 'cache', 'progress.json');
      const progress = readProgress(progressPath);
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
      // No 'triage' row: 'evaluate / skipped' is already shown in the
      // Forecast `files` line (e.g. '12 of 15 (3 skipped by triage)').

      // RAG indexing scope — merged with the rag mode label in the
      // Configuration block (e.g. `rag   lite — 8 files · 17 fns · 34 chunks`).
      let embedForecast: ReturnType<typeof estimateEmbedTokens> | undefined;
      let ragScopeFragment = '';
      if (enableRag) {
        const ragFiles = allTasks.filter(t =>
          t.symbols.some(s => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
        ).length;
        const docsPath = config.documentation?.docs_path ?? 'docs';
        embedForecast = estimateEmbedTokens(projectRoot, allTasks, [docsPath, join('.anatoly', 'docs')]);
        ragScopeFragment = ` — ${ragFiles} files · ${embedForecast.codeUnits} fns · ${embedForecast.nlpUnits} chunks`;
      }
      configRows.push({ key: 'rag', value: ragLabel + ragScopeFragment });

      // Build the usage graph for the JSON payload's plan.usageGraph.edges
      // diagnostic. Not surfaced in the rendered view (opaque metric).
      const usageGraph = buildUsageGraph(projectRoot, allTasks);

      // docs status — merged into Configuration as a `docs` row.
      const bootstrapNeeded = needsBootstrap(projectRoot);
      let docsValue: string;
      if (bootstrapNeeded) {
        docsValue = 'first run (bootstrap)';
      } else if (docScanInternal) {
        const projectFragment = docScanProject
          ? `project ${docScanProject.changed} changed`
          : 'project deduplicated';
        docsValue = `${docScanInternal.changed} changed, ${docScanInternal.cached} cached · ${projectFragment}`;
      } else {
        docsValue = '.anatoly/docs/ ready';
      }
      configRows.push({ key: 'docs', value: docsValue });

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
        ...(config.models.deliberation ? { deliberationModel: config.models.deliberation } : {}),
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
      });
    });
}
