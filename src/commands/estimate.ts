// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { loadConfig, getV3Source } from '../utils/config-loader.js';
import type { Config } from '../schemas/config.js';
import { extractProvider } from '../core/transports/index.js';
import { scanProject } from '../core/scanner.js';
import { forecastRun, formatTokenCount, loadTasks, FORECAST_STEP_CATEGORY_ORDER, type ForecastStep } from '../core/estimator.js';
import { loadCalibration, formatCalibratedTime } from '../core/calibration.js';
import { ensurePricing } from '../utils/pricing-cache.js';
import { enumerateActiveModels } from '../utils/active-models.js';
import { getLogger } from '../utils/logger.js';
import { getEnabledEvaluators, ALL_AXIS_IDS } from '../core/axes/index.js';
import { resolveAxisModel, resolveCodeSummaryModel, type AxisId } from '../core/axis-evaluator.js';
import picomatch from 'picomatch';
import { triageFile } from '../core/triage.js';
import { buildUsageGraph } from '../core/usage-graph.js';
import { needsBootstrap } from '../core/doc-bootstrap.js';
import { computeScaffoldPageList } from '../core/doc-pipeline.js';
import { detectProjectProfile, formatLanguageLine, formatFrameworkLine } from '../core/language-detect.js';
import { detectHardware, readEmbeddingsReadyFlag, resolveEmbeddingModels, type ResolvedModels } from '../rag/hardware-detect.js';
import { countChangedDocs } from '../rag/doc-indexer.js';
import { estimateEmbedTokens } from '../rag/embed-estimator.js';
import { readProgress } from '../utils/cache.js';
import chalk from 'chalk';
import Table from 'cli-table3';

/**
 * Resolve the per-step billing mode from a model id + the resolved Config.
 * Keeps a single source of truth: `subscription` / `api` come from
 * `config.providers.<provider>.mode`, `local` is detected from the
 * known-local embedding labels map.
 */
function makeBillingResolver(config: Config): (modelId: string) => 'subscription' | 'api' | 'local' {
  return (modelId: string) => {
    if (modelId === 'local' || KNOWN_LOCAL_LABELS[modelId]) return 'local';
    const provider = extractProvider(modelId);
    const providers = config.providers as Record<string, { mode?: 'subscription' | 'api' } | undefined>;
    return providers[provider]?.mode === 'subscription' ? 'subscription' : 'api';
  };
}

/**
 * Compact, readable label for a model id. Keeps the provider prefix
 * (`anthropic/`, `voyage/`, …) so the user sees full attribution; only the
 * trailing release date suffix is stripped for visual brevity.
 *
 * Local-runtime embedding models (ONNX / GGUF) carry awkward HuggingFace
 * paths or internal ids that don't read well — we map them to friendly
 * `name dim (local)` labels via {@link KNOWN_LOCAL_LABELS} so the user
 * sees "jina-v2 768d (local)" instead of "jinaai/jina-embeddings-v2-base-code".
 */
const KNOWN_LOCAL_LABELS: Record<string, string> = {
  'jinaai/jina-embeddings-v2-base-code': 'jina-v2 768d (local)',
  'Xenova/all-MiniLM-L6-v2': 'MiniLM-L6 384d (local)',
  'Xenova/nomic-embed-text-v1': 'nomic-text-v1 768d (local)',
  'nomic-embed-code-gguf': 'nomic-embed-code Q5_K_M (local)',
  'qwen3-embedding-8b-gguf': 'Qwen3-8B Q5_K_M (local)',
};

function displayModel(modelId: string): string {
  if (modelId === 'local') return '(local)';
  if (KNOWN_LOCAL_LABELS[modelId]) return KNOWN_LOCAL_LABELS[modelId];
  return modelId.replace(/-\d{8}$/, ''); // strip trailing -YYYYMMDD release date
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
  forecast: {
    filesValue: string;
    tokensValue: string;
    /** Sum of all step costs — the consumption magnitude (API equivalent). */
    totalCostUsd: number;
    /** What the user actually pays — sum of `api`-mode steps only. */
    billedUsd: number;
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

  // No 'Used Models' section: every active model already appears in the
  // Cost breakdown alongside its $ contribution (axes, deliberation,
  // summary, embed/code, embed/text, internal-doc/bootstrap-or-update).
  // Listing them twice (once with model id only, once with model+cost)
  // diverged in ordering and was missing 'deliberation' anyway.

  // --- Cost breakdown — single 5-column table so all values stack with
  // uniform column widths. Columns: category, step, cost, mode, model.
  // Category column is left blank on consecutive rows of the same group.
  // Ends with two totals: `total billed` (real $ paid — sum of api-mode rows)
  // and `total consumption equivalent` (sum of all rows, the API equivalent
  // magnitude — informative when subscription mode covers some/all of it).
  {
    console.log('');
    console.log('  ' + chalk.yellow.bold('Cost breakdown') + ' ' + chalk.dim('based on latest public provider price'));
    console.log('  ' + chalk.dim('─'.repeat(14)));

    const sorted = sortSteps(data.forecast.steps);
    const t = newTable({
      head: ['category', 'step', 'cost', 'mode', 'model'],
      colAligns: ['left', 'left', 'right', 'left', 'left'],
    });
    let lastCategory = '';
    let billedUsd = 0;
    for (const s of sorted) {
      const cost = (s.approximate ? '~' : '') + '$' + s.costUsd.toFixed(2);
      const categoryCell = s.category === lastCategory ? '' : chalk.dim(s.category);
      lastCategory = s.category;
      if (s.billingMode === 'api') billedUsd += s.costUsd;
      t.push([categoryCell, s.name, cost, chalk.dim(s.billingMode), displayModel(s.model)]);
    }

    // Empty row + two totals.
    t.push(['', '', '', '', '']);
    t.push([
      chalk.bold('total billed'),
      '',
      chalk.yellow.bold('$' + billedUsd.toFixed(2)),
      '',
      '',
    ]);
    t.push([
      chalk.dim('consumption'),
      '',
      chalk.dim('~$' + data.forecast.totalCostUsd.toFixed(2)),
      '',
      '',
    ]);

    console.log(t.toString());
  }

  // --- Forecast — the verdict, last so the user's eye lands on it.
  // The cost line takes the *billed* amount (what the user actually pays),
  // with the consumption equivalent as a hint when subscription mode
  // covers some/all of the work. ---
  {
    const billed = data.forecast.billedUsd;
    const consumption = data.forecast.totalCostUsd;
    const allCovered = billed === 0 && consumption > 0;
    const allBilled = Math.abs(billed - consumption) < 0.01;

    let costValue: string;
    if (allCovered) {
      costValue = chalk.yellow.bold('$0')
        + ' in subscription mode  '
        + chalk.dim(`(ensure quota for ~$${consumption.toFixed(2)})`);
    } else if (allBilled) {
      costValue = chalk.yellow.bold(`$${consumption.toFixed(2)}`)
        + ' in consumption mode';
    } else {
      costValue = chalk.yellow.bold(`$${billed.toFixed(2)}`)
        + ' billed  '
        + chalk.dim(`(~$${consumption.toFixed(2)} consumption equivalent)`);
    }

    const rows = [
      { key: 'files', value: data.forecast.filesValue },
      { key: 'tokens', value: data.forecast.tokensValue },
      { key: 'cost', value: costValue },
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
  /**
   * Mirrors the rendered Configuration section verbatim. `rag` and `docs`
   * carry their structural details (scope counts, mode) inline so the JSON
   * stays a strict projection of what the user sees in the table.
   */
  config: {
    concurrency: number;
    cache: boolean;
    rag: {
      mode: 'off' | 'lite' | 'advanced' | 'external';
      files?: number;
      fns?: number;
      chunks?: number;
    };
    docs: {
      mode: 'bootstrap' | 'update' | 'ready' | 'skipped';
      internal?: { changed: number; cached: number };
      project?: { changed: number; cached: number };
    };
    /**
     * CLI-scope filters that narrowed the forecast. Absent when the user
     * ran `anatoly estimate` with no scoping flags (full default forecast).
     */
    scope?: {
      filesGlob?: string;
      axes?: AxisId[];
      noRag?: true;
      noDeliberation?: true;
      noInternalDocs?: true;
      noCache?: true;
    };
  };
  /**
   * Mirrors the rendered Forecast + Cost breakdown sections. `cost` only
   * carries the two totals shown in the breakdown footer (billed and
   * consumption); per-model / per-category aggregates are derivable from
   * `steps` and intentionally omitted from this top-level view.
   */
  forecast: {
    files: { total: number; evaluate: number; skipped: number };
    tokens: {
      llm: { inputTokens: number; outputTokens: number };
      embed: { tokens: number; codeUnits: number; textUnits: number };
      total: number;
    };
    cost: {
      /** What the user actually pays — sum of `api`-mode step costs. */
      billedUsd: number;
      /** Sum of all step costs — pay-per-token equivalent (consumption). */
      consumptionUsd: number;
    };
    time: { minutes: number; calibrated: boolean };
    steps: ForecastStep[];
  };
}

/** Registers the `estimate` CLI sub-command on the given Commander program. @param program The root Commander instance. */
export function registerEstimateCommand(program: Command): void {
  program
    .command('estimate')
    .description('Show the startup summary table (no LLM calls)')
    .option('--json', 'emit a machine-readable JSON payload to stdout instead of the rendered table (logs go to stderr)')
    .option('--files <glob>', 'forecast only files matching this glob (incremental scope preview)')
    .option('--axes <list>', 'comma-separated axis ids to include (default: all enabled in config)')
    .option('--no-deliberation', 'forecast as if the deliberation pass were disabled')
    .option('--no-internal-docs', 'forecast as if internal-doc generation were skipped')
    .option('--no-cache', 'forecast as if running from scratch — ignore CACHED state, bill every file matched by scan')
    .action(async (cmdOpts: {
      json?: boolean;
      files?: string;
      axes?: string;
      deliberation?: boolean;
      internalDocs?: boolean;
      cache?: boolean;
    }) => {
      const jsonMode = cmdOpts.json === true;
      const filesGlob = cmdOpts.files;
      const ignoreCache = cmdOpts.cache === false;
      const matchFiles = filesGlob ? picomatch(filesGlob) : null;
      // Commander's `--no-foo` flips the flag's default to `true` and sets it
      // to `false` when --no-foo is passed. We treat `undefined` as "not
      // overridden" → fall through to the config-driven default. `--no-rag`
      // is defined on the parent program (see cli.ts), so we read it from
      // `program.opts()` rather than from this subcommand's cmdOpts.
      const ragOverride = program.opts().rag === false ? false : undefined;
      const deliberationOverride = cmdOpts.deliberation === false ? false : undefined;
      const internalDocsOverride = cmdOpts.internalDocs === false ? false : undefined;
      let axesFilter: AxisId[] | undefined;
      if (cmdOpts.axes !== undefined) {
        const requested = cmdOpts.axes.split(',').map((s) => s.trim()).filter(Boolean) as AxisId[];
        const unknown = requested.filter((id) => !ALL_AXIS_IDS.includes(id));
        if (unknown.length > 0) {
          process.stderr.write(
            `✖ Unknown axis id(s): ${unknown.join(', ')}.\n  Known axes: ${ALL_AXIS_IDS.join(', ')}\n`,
          );
          process.exit(1);
        }
        axesFilter = requested;
      }
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

      // Always rescan: cheap (no LLM), keeps `.anatoly/tasks/` in sync with
      // the current source tree, and yields fresh new/modified/cached counts
      // for the forecast block. Stale tasks from a previous scan with a
      // different scope no longer leak into the forecast.
      const scanResult = await scanProject(projectRoot, config);

      // --- Project info ---
      let projectInfo: { name: string; version: string; languages?: string; frameworks?: string } | undefined;
      try {
        const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as Record<string, unknown>;
        if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
          projectInfo = { name: pkg.name, version: pkg.version };
        }
      } catch { /* no package.json */ }

      const profile = await detectProjectProfile(projectRoot);
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
      // RAG can be force-disabled by --no-rag — gate the config-driven default.
      const enableRag = ragOverride === false ? false : config.rag.enabled;
      let ragLabel = ragOverride === false ? 'off (--no-rag)' : 'off';
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
        { key: 'cache', value: ignoreCache ? 'ignored (--no-cache)' : 'on' },
      ];

      // Surface active CLI scope filters as a single 'scope' row — but only
      // for overrides that don't have their own row. The 'rag' and 'docs'
      // rows already carry their --no-rag / --no-internal-docs override
      // inline (e.g. `rag   off (--no-rag)`), so listing them again in
      // 'scope' would be redundant. 'scope' therefore holds: files glob,
      // axes filter, deliberation suppression — the things with no
      // dedicated row to show them.
      const scopeFragments: string[] = [];
      if (filesGlob) scopeFragments.push(`files: ${filesGlob}`);
      if (axesFilter) scopeFragments.push(`axes: ${axesFilter.join(',')}`);
      if (deliberationOverride === false) scopeFragments.push('no deliberation');
      if (scopeFragments.length > 0) {
        configRows.push({ key: 'scope', value: scopeFragments.join(' · ') });
      }

      // Active axis evaluators — used by the JSON payload's models.axes
      // field and to drive the forecast's per-axis token math. The optional
      // --axes filter intersects with the config-enabled set.
      const evaluators = getEnabledEvaluators(config, axesFilter);

      const allTasksUnfiltered = loadTasks(projectRoot);
      const allTasks = matchFiles
        ? allTasksUnfiltered.filter((t) => matchFiles(t.file))
        : allTasksUnfiltered;

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
      //
      // RAG indexes the WHOLE project regardless of `--files` (the filter
      // only narrows axis review, not the index). So this section is sized
      // from `allTasksUnfiltered`. Without this fix, scoping to one file
      // collapsed the RAG/NLP-summary forecast by ~order of magnitude — R1
      // forecast was $0.001 against $0.27 actual (8 haiku summaries over
      // the full project's 17 functions).
      let embedForecast: ReturnType<typeof estimateEmbedTokens> | undefined;
      let ragScopeFragment = '';
      if (enableRag) {
        const ragFiles = allTasksUnfiltered.filter(t =>
          t.symbols.some(s => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
        ).length;
        const docsPath = config.documentation?.docs_path ?? 'docs';
        embedForecast = estimateEmbedTokens(projectRoot, allTasksUnfiltered, [docsPath, join('.anatoly', 'docs')]);
        ragScopeFragment = ` — ${ragFiles} files · ${embedForecast.codeUnits} fns · ${embedForecast.nlpUnits} chunks`;
      }
      configRows.push({ key: 'rag', value: ragLabel + ragScopeFragment });

      // Build the usage graph for the JSON payload's plan.usageGraph.edges
      // diagnostic. Not surfaced in the rendered view (opaque metric).
      const usageGraph = buildUsageGraph(projectRoot, allTasks);

      // docs status — merged into Configuration as a `docs` row.
      const bootstrapNeeded = needsBootstrap(projectRoot);
      let docsValue: string;
      if (internalDocsOverride === false) {
        docsValue = 'skipped (--no-internal-docs)';
      } else if (ignoreCache) {
        docsValue = 'forced bootstrap (--no-cache)';
      } else if (bootstrapNeeded) {
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
      // evalTasks = tasks the run will actually call the LLM for. Two filters:
      //   1. Drop tasks whose progress.json status is CACHED — they hit the
      //      eval cache and the run skips them ($0).
      //   2. Drop tasks the triage decides to skip on content grounds.
      // Without the cache filter the forecast over-counted cached files and
      // inflated the predicted token total even though those files cost $0.
      // Track the two skip causes separately so the display can show
      // "N cached, M skipped by triage" rather than mashing them together.
      const calibration = loadCalibration(projectRoot);
      let cachedSkipCount = 0;
      let triageSkipCount = 0;
      const evalTasks = allTasks.filter(t => {
        const progressEntry = progress?.files[t.file];
        if (progressEntry?.status === 'CACHED') {
          cachedSkipCount++;
          // --no-cache: count cached files for display, but keep them in the
          // forecast so the cost reflects a from-scratch run.
          if (!ignoreCache) return false;
        }
        try {
          const source = readFileSync(resolve(projectRoot, t.file), 'utf-8');
          if (triageFile(t, source).tier !== 'evaluate') {
            triageSkipCount++;
            return false;
          }
          return true;
        } catch {
          return true; // unreadable file: treat as evaluate (matches triage fallback)
        }
      });
      // Always attach the resolved embedding model ids when RAG is on —
      // including for local backends. Pricing-wise it's a no-op (local
      // models have no upstream entry, so calculateCost returns 0), but it
      // gives the display layer the actual model id to render (e.g.
      // 'jina-v2 768d (local)' instead of a generic '(local)').
      const embedWithModels = embedForecast
        ? {
            ...embedForecast,
            ...(resolvedEmbed
              ? { codeModel: resolvedEmbed.codeModel, nlpModel: resolvedEmbed.nlpModel }
              : {}),
          }
        : undefined;
      // Doc-gen forecast: pick mode + page count for the heuristic.
      // Bootstrap page count comes from the SAME page-list builder the
      // runtime scaffolder uses — base pages + project-type extras +
      // dynamic module pages — so the forecast tracks reality (BASE_PAGES
      // alone is 18, dwarfing the prior `max(8, ceil(N/12))` heuristic
      // which floored at 8). Uses unfiltered tasks: scaffolding runs over
      // the whole project regardless of `--files` review scope.
      // --no-cache forces a from-scratch forecast: docs are treated as
      // bootstrap (every page billed) regardless of `.anatoly/docs/` state,
      // matching the rest of the from-scratch semantics (every file billed,
      // no eval-cache shortcut).
      const docMode: 'bootstrap' | 'update' = ignoreCache || bootstrapNeeded ? 'bootstrap' : 'update';
      const docPageCount = docMode === 'bootstrap'
        ? computeScaffoldPageList(allTasksUnfiltered, profile).length
        : (docScanInternal?.changed ?? 0);
      const scaffoldingModel = config.agents.scaffolding ?? config.models.quality;

      const forecast = forecastRun({
        projectRoot,
        evalTasks,
        totalFiles: allTasks.length,
        axes: evaluators.map(e => ({ id: e.id, model: resolveAxisModel(e, config) })),
        ...(embedWithModels ? { embed: embedWithModels } : {}),
        ...(enableRag ? { summaryModel: resolveCodeSummaryModel(config) } : {}),
        ...(deliberationOverride !== false && config.models.deliberation
          ? { deliberationModel: config.models.deliberation }
          : {}),
        ...(internalDocsOverride !== false && docPageCount > 0
          ? { docContext: { mode: docMode, pageCount: docPageCount, scaffoldingModel } }
          : {}),
        resolveBillingMode: makeBillingResolver(config),
        calibration,
        concurrency,
        ragEnabled: enableRag,
        deliberation: deliberationOverride !== false,
      });
      const calLabel = forecast.hasCalibration ? 'calibrated' : 'default';

      // --- JSON mode: emit a versioned payload, skip the rendered view. ---
      if (jsonMode) {
        // Touch usageGraph so the (still computed) build doesn't generate a
        // dead-code warning. We deliberately don't surface it in the JSON
        // anymore — it isn't shown in the rendered table either.
        void usageGraph;

        const docsMode: 'bootstrap' | 'update' | 'ready' | 'skipped' = internalDocsOverride === false
          ? 'skipped'
          : bootstrapNeeded
            ? 'bootstrap'
            : (docScanInternal?.changed ?? 0) > 0 ? 'update' : 'ready';

        const scope: NonNullable<EstimateJsonPayload['config']['scope']> = {
          ...(filesGlob ? { filesGlob } : {}),
          ...(axesFilter ? { axes: axesFilter } : {}),
          ...(ragOverride === false ? { noRag: true as const } : {}),
          ...(deliberationOverride === false ? { noDeliberation: true as const } : {}),
          ...(internalDocsOverride === false ? { noInternalDocs: true as const } : {}),
          ...(ignoreCache ? { noCache: true as const } : {}),
        };
        const hasScope = Object.keys(scope).length > 0;

        const billedUsd = forecast.steps
          .filter((s) => s.billingMode === 'api')
          .reduce((sum, s) => sum + s.costUsd, 0);

        const ragFiles = enableRag
          ? allTasks.filter(t =>
              t.symbols.some(s => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
            ).length
          : 0;

        const payload: EstimateJsonPayload = {
          schemaVersion: ESTIMATE_SCHEMA_VERSION,
          timestamp: new Date().toISOString(),
          ...(projectInfo ? { project: projectInfo } : {}),
          config: {
            concurrency,
            cache: !ignoreCache,
            rag: {
              mode: (enableRag ? (resolvedEmbed?.backend ?? 'lite') : 'off') as EstimateJsonPayload['config']['rag']['mode'],
              ...(enableRag && embedForecast
                ? { files: ragFiles, fns: embedForecast.codeUnits, chunks: embedForecast.nlpUnits }
                : {}),
            },
            docs: {
              mode: docsMode,
              ...(docScanInternal ? { internal: { changed: docScanInternal.changed, cached: docScanInternal.cached } } : {}),
              ...(docScanProject ? { project: { changed: docScanProject.changed, cached: docScanProject.cached } } : {}),
            },
            ...(hasScope ? { scope } : {}),
          },
          forecast: {
            files: { total: forecast.totalFiles, evaluate: forecast.files, skipped: forecast.skippedFiles },
            tokens: {
              llm: { inputTokens: forecast.llm.inputTokens, outputTokens: forecast.llm.outputTokens },
              embed: { tokens: forecast.embed.tokens, codeUnits: forecast.embed.codeUnits, textUnits: forecast.embed.nlpUnits },
              total: forecast.totalTokens,
            },
            cost: {
              billedUsd,
              consumptionUsd: forecast.totalCostUsd,
            },
            time: { minutes: forecast.calibratedMin, calibrated: forecast.hasCalibration },
            steps: sortSteps(forecast.steps),
          },
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        return;
      }

      // Forecast block (estimate command only — verdict before pipeline detail).
      const totalTokensFragment = `${formatTokenCount(forecast.llm.inputTokens)} in / ${formatTokenCount(forecast.llm.outputTokens)} out`
        + (forecast.embed.tokens > 0 ? ` + ${formatTokenCount(forecast.embed.tokens)} embed` : '');
      // Build the files line. Two orthogonal axes:
      //   - Freshness from the scanner: how many files are new vs modified
      //     vs unchanged (cached) in the source tree.
      //   - Skip cause for the run: cached files hit the eval cache ($0);
      //     triage skips files on content grounds.
      // Showing both gives the user the full picture of why the forecast
      // bills only `forecast.files` out of `forecast.totalFiles` — separating
      // the cache skip from the triage skip avoids the misleading merge.
      // Two distinct cache signals to surface:
      //   - SHA-unchanged: source hash matches a prior scan. Pure freshness
      //     info — no cost implication on its own.
      //   - Eval-cached: the run skipped this file last time because the eval
      //     result was already cached ($0). This is a strict subset of
      //     SHA-unchanged (an eval-cached file always has a stable hash).
      // We render them as `K cached (J evaluated)` so the user sees both:
      // how stable the tree is and how much of that stability the eval cache
      // actually capitalises on.
      const freshnessParts: string[] = [];
      if (scanResult.filesNew > 0) freshnessParts.push(`${scanResult.filesNew} new`);
      if (scanResult.filesModified > 0) freshnessParts.push(`${scanResult.filesModified} modified`);
      if (scanResult.filesCached > 0) {
        const evaluatedSuffix = cachedSkipCount > 0
          ? ignoreCache
            ? ` (${cachedSkipCount} evaluated, re-billed)`
            : ` (${cachedSkipCount} evaluated)`
          : '';
        freshnessParts.push(`${scanResult.filesCached} cached${evaluatedSuffix}`);
      }
      if (triageSkipCount > 0) freshnessParts.push(`${triageSkipCount} skipped by triage`);
      const breakdown = freshnessParts.length > 0 ? `  (${freshnessParts.join(', ')})` : '';
      const filesFragment = forecast.skippedFiles > 0
        ? `${forecast.files} of ${forecast.totalFiles}${breakdown}`
        : `${forecast.files} files${breakdown}`;

      const billedUsd = forecast.steps
        .filter((s) => s.billingMode === 'api')
        .reduce((sum, s) => sum + s.costUsd, 0);

      renderEstimateView({
        project: projectInfo,
        config: configRows,
        forecast: {
          filesValue: filesFragment,
          tokensValue: totalTokensFragment,
          totalCostUsd: forecast.totalCostUsd,
          billedUsd,
          timeValue: `${formatCalibratedTime(forecast.calibratedMin)}  (${calLabel})`,
          steps: forecast.steps,
        },
      });
    });
}
