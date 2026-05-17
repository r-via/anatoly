// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Setup phase (extracted from run.ts in PR 3, doc 11 Strategy B).
 *
 * Move-only: the body below is the verbatim `runSetupPhase` from run.ts (the
 * only edit is the `export` keyword; no inline imports, no relocated-helper
 * renames in the body). It still returns `SetupResult` and the spine still
 * calls it via the unchanged `const setup = await runSetupPhase(ctx)` site.
 *
 * `SetupResult` now lives in the typed handoff contract (handoff.ts). The one
 * run.ts-local helper this phase used, `isDocAxisActive`, was relocated to
 * the axis-enablement module. `RunContext` is imported type-only (erased):
 * no runtime cycle, no runtime dependency on the commands layer. The import
 * list starts as run.ts's (path-rewritten) and is pruned to setup's actual
 * needs.
 *
 * Post-PR-8 state (doc 11): the orchestration spine lives in
 * pipeline.ts (PR 8a), not run.ts; this phase receives the typed
 * `Handoff` object explicitly as a parameter (PR 8c) and the §4
 * inter-phase data is no longer `ctx` mutation. Any line above
 * describing a run.ts call site, `ctx`-mutation, or "handoff
 * untouched until PR 8" is extraction-era history, superseded here.
 */

import { readFileSync } from 'node:fs';
import { resolve, join, relative, basename } from 'node:path';
import chalk from 'chalk';
import * as p from '@clack/prompts';
import picomatch from 'picomatch';
import { getDocsDir } from '../../../schemas/config.js';
import { scanProject } from '../../scanner.js';
import { estimateTasksTokens, formatTokenCount, loadTasks, forecastRun } from '../../estimator.js';
import { estimateEmbedTokens } from '../../../rag/embed-estimator.js';
import { loadCalibration, estimateCalibratedMinutes, formatCalibratedTime } from '../../calibration.js';
import { AnatolyError, ERROR_CODES } from '../../../utils/errors.js';
import { countChangedDocs } from '../../../rag/index.js';
import { isSystemLocalProvider } from '../../../rag/system-providers.js';
import { detectHardware, readEmbeddingsReadyFlag } from '../../../rag/hardware-detect.js';
import { getLogger } from '../../../utils/logger.js';
import type { Task } from '../../../schemas/task.js';
import { triageFile, type TriageResult } from '../../triage.js';
import { buildUsageGraph } from '../../usage-graph.js';
import { loadDependencyMeta } from '../../dependency-meta.js';
import { getEnabledEvaluators } from '../../axes/index.js';
import { buildProjectTree } from '../../project-tree.js';
import { buildDocsTree } from '../../docs-resolver.js';
import { resolveAxisModel, resolveCodeSummaryModel, resolveDeliberationModel } from '../../axis-evaluator.js';
import { extractProvider } from '../../transports/index.js';
import { printSetupToAuditTransition } from '../../../utils/transitions.js';
import { resolveDocMode } from '../../run-config.js';
import { renderSetupTable, shortModelName } from '../../../cli/setup-table.js';
import { runHints } from '../../../cli/hint-detector.js';
import { runEndOfSetupPrompt } from '../../../cli/setup-prompts.js';
import { detectProjectProfile, formatLanguageLine, formatFrameworkLine } from '../../language-detect.js';
import { detectProjectIdentity } from '../../project-version.js';
import { needsBootstrap } from '../../doc-bootstrap.js';
import { getEffectiveSourceRoot } from '../../worktree-path-resolution.js';
import { anatolyPath } from '../../../utils/anatoly-paths.js';
import { runPhase } from '../run-phase.js';
import { countPendingDocConflicts } from '../../doc-conflict-store.js';
import type { SetupResult, Handoff } from '../handoff.js';
import { isDocAxisActive } from '../../axes/index.js';
import type { RunContext } from '../../../commands/run.js';

export async function runSetupPhase(ctx: RunContext, handoff: Handoff): Promise<SetupResult> {
  const log = getLogger();
  const rl = ctx.runLog;
  // Banner is printed at the very start of the run command so all
  // launch-time notices (warnings, errors, info hints) appear under it
  // in a consistent block.

  // sourceRoot is the directory from which source files are read (worktree or projectRoot)
  const srcRoot = getEffectiveSourceRoot(ctx.projectRoot, ctx.sourceRoot);

  let estimateFiles = 0;
  const triageMap = new Map<string, TriageResult>();
  let allTasks: Task[] = [];
  const configRows: { key: string; value: string }[] = [];
  const pipelineRows: { phase: string; detail: string }[] = [];

  // --- Detect project identity (name + version) + languages/frameworks ---
  // detectProjectProfile walks the filesystem with linguist-js, which can take
  // a few seconds on large repos \u2014 surface a spinner so the user knows we're
  // not stuck after the banner. Non-TTY fallback emits a single log line so
  // CI/pipe runs still get the signal.
  const projectInfoSpinner = process.stdout.isTTY ? p.spinner() : null;
  projectInfoSpinner?.start('Retrieving project info (version, languages, frameworks)\u2026');
  if (!projectInfoSpinner) getLogger().info('retrieving project info\u2026');

  // detectProjectIdentity also walks `git describe --tags` for Go projects;
  // run it inside the same spinner so both probes share the visible wait.
  const identity = detectProjectIdentity(srcRoot);
  const profile = await detectProjectProfile(srcRoot);
  ctx.profile = profile;
  const langLine = formatLanguageLine(profile.languages.languages);
  const fwLine = formatFrameworkLine(profile.frameworks);

  let projectInfo: { name: string; version: string; languages?: string; frameworks?: string } | undefined = {
    name: identity.name,
    version: identity.version ?? '\u2014',
  };
  if (langLine) projectInfo.languages = langLine;
  if (fwLine) projectInfo.frameworks = fwLine;

  // If nothing whatsoever was detected (no manifest, no languages, no frameworks),
  // suppress the project-info card to keep the summary clean.
  if (!identity.version && !langLine && !fwLine && identity.name === basename(srcRoot)) {
    projectInfo = undefined;
  }

  projectInfoSpinner?.stop(projectInfo ? 'Project info ready' : 'Project info: nothing detected');
  // clack's spinner.stop doesn't emit the trailing `│` separator that
  // interactive prompts use to visually link to the next block. Add it
  // ourselves so the next prompt doesn't look orphaned.
  if (projectInfoSpinner) process.stdout.write(chalk.gray('│') + '\n');

  // --- Phase: config ---
  let hardware: ReturnType<typeof detectHardware> | undefined;
  if (ctx.enableRag) {
    hardware = detectHardware();

    if (ctx.ragMode === 'lite') {
      if (ctx.config.rag.code_model === 'auto') {
        ctx.config.rag.code_model = 'jinaai/jina-embeddings-v2-base-code';
      }
    }

    // Determine the effective RAG mode from CLI flags + hardware + readiness flag.
    // Embedding containers are NOT started yet — that happens in runRagPhase.
    //
    // External-tier inference: if the user added `rag.embedding` to their
    // .anatoly.yml outside the wizard flow, no readiness flag was ever
    // written. Honour the config anyway so the runtime tier matches what
    // resolveEmbeddingModels will route to (otherwise embeddings silently
    // fall back to ONNX lite while the user thinks they're on external).
    // The system providers `local-advanced` (Docker GGUF sidecar) and
    // `local-lite` (ONNX in-process) also populate `rag.embedding.{code,nlp}`
    // through the v3 adapter — exclude them so a local setup isn't mislabeled
    // "external".
    const embeddingsReady = readEmbeddingsReadyFlag(ctx.projectRoot);
    const codeProvider = ctx.config.rag.embedding?.code?.provider;
    const nlpProvider = ctx.config.rag.embedding?.nlp?.provider;
    const hasExternalConfig =
      (codeProvider !== undefined && !isSystemLocalProvider(codeProvider))
      || (nlpProvider !== undefined && !isSystemLocalProvider(nlpProvider));
    const isExternalReady = embeddingsReady?.backend === 'external' || hasExternalConfig;
    // A previous successful setup that wrote advanced-gguf into the ready flag
    // is stronger evidence of GPU availability than a runtime nvidia-smi probe
    // (which fails when anatoly is launched from a non-login shell that misses
    // nvidia-smi on PATH). Trust the flag: otherwise the GGUF SDK provider
    // still gets wired via the config, but startGgufContainers is skipped,
    // and lazy ensureModel calls bind-mount an empty `null` volume.
    const ranAdvancedBefore = embeddingsReady?.backend === 'advanced-gguf';
    const canAdvanced = (hardware.hasGpu || ranAdvancedBefore) && embeddingsReady !== null && !isExternalReady;
    const needsSidecar = ctx.ragMode === 'advanced'
      || (ctx.ragMode === 'auto' && canAdvanced && ctx.config.rag.code_model === 'auto');
    if (isExternalReady && ctx.ragMode === 'auto') {
      ctx.resolvedRagMode = 'external';
    } else {
      ctx.resolvedRagMode = needsSidecar ? 'advanced' : 'lite';
    }

    rl?.info({
      hardware: {
        memoryGB: hardware.totalMemoryGB,
        cpuCores: hardware.cpuCores,
        gpu: hardware.hasGpu ? hardware.gpuType : 'none',
      },
      ragMode: ctx.resolvedRagMode,
    }, 'hardware detection');
  }

  const ragLabel = ctx.enableRag ? (ctx.resolvedRagMode ?? 'lite') : 'off';
  configRows.push(
    { key: 'concurrency', value: `${ctx.concurrency} files · ${ctx.config.providers.google ? `${ctx.config.providers.anthropic?.concurrency ?? 8} Claude + ${ctx.config.providers.google.concurrency} Gemini slots` : `${ctx.config.providers.anthropic?.concurrency ?? 8} Claude slots`}` },
    { key: 'rag', value: ragLabel },
    { key: 'cache', value: ctx.noCache ? 'off' : 'on' },
  );
  if (ctx.fileFilter) configRows.push({ key: 'filter', value: ctx.fileFilter });
  if (ctx.userInstructions) configRows.push({ key: 'custom rules', value: ctx.userInstructions.recognizedSections.join(', ') });
  configRows.push({ key: 'run', value: ctx.runId });
  const depMeta = loadDependencyMeta(srcRoot);

  // --- Build models rows (left: axes, right: embeddings/chunking/summarization) ---
  const evaluators = getEnabledEvaluators(ctx.config, ctx.axesFilter);
  const modelsLeft: { key: string; value: string }[] = evaluators.map(e => ({
    key: e.id as string,
    value: shortModelName(resolveAxisModel(e, ctx.config)),
  }));
  if (ctx.deliberation) {
    modelsLeft.push({ key: 'deliberation', value: shortModelName(resolveDeliberationModel(ctx.config)) });
  }
  const modelsRight: { key: string; value: string }[] = [];
  if (ctx.enableRag) {
    if (ctx.resolvedRagMode === 'advanced') {
      modelsRight.push({ key: 'embeddings/code', value: 'nomic-embed-code Q5_K_M' });
      modelsRight.push({ key: 'embeddings/nlp', value: 'Qwen3-8B Q5_K_M' });
    } else if (ctx.resolvedRagMode === 'external') {
      const emb = ctx.config.rag.embedding;
      const codeLabel = emb?.code?.model ? shortModelName(emb.code.model) : 'external (code)';
      const nlpLabel = emb?.nlp?.model ? shortModelName(emb.nlp.model) : 'external (nlp)';
      modelsRight.push({ key: 'embeddings/code', value: codeLabel });
      modelsRight.push({ key: 'embeddings/nlp', value: nlpLabel });
    } else {
      modelsRight.push({ key: 'embeddings/code', value: 'jina-v2 768d' });
      modelsRight.push({ key: 'embeddings/nlp', value: 'MiniLM-L6 384d' });
    }
    modelsRight.push({ key: 'chunking', value: 'smartChunkDoc (no LLM)' });
    modelsRight.push({ key: 'summarization', value: shortModelName(resolveCodeSummaryModel(ctx.config)) });
  }

  // --- Phase: scan ---
  const scanResult = await runPhase(ctx, 'scan', async () => scanProject(srcRoot, ctx.config, evaluators.map(e => e.id)));
  pipelineRows.push({ phase: 'source files', detail: `${scanResult.filesScanned} files (${scanResult.filesNew} new, ${scanResult.filesCached} cached)` });
  let docScanProject: ReturnType<typeof countChangedDocs> = null;
  let docScanInternal: ReturnType<typeof countChangedDocs> = null;
  if (ctx.enableRag) {
    const ragSuffix = ctx.resolvedRagMode ?? 'lite';
    const docsPath = getDocsDir(ctx.config);
    docScanProject = countChangedDocs(srcRoot, docsPath, ragSuffix);
    docScanInternal = countChangedDocs(srcRoot, join('.anatoly', 'state', 'internal-docs'), `${ragSuffix}-internal`);
  }
  if (ctx.verbose) {
    log.debug({ filesScanned: scanResult.filesScanned, filesNew: scanResult.filesNew, filesCached: scanResult.filesCached }, 'scan complete');
  }

  // --- Phase: estimate ---
  let estimateTasks: Task[];
  await runPhase(ctx, 'estimate', async () => {
    const rawTasks = loadTasks(srcRoot);
    // Filter to only tasks for files in the current scan (excludes stale tasks from previously scanned files)
    const scannedFileSet = scanResult.files ? new Set(scanResult.files.map((f) => f.file)) : undefined;
    allTasks = scannedFileSet ? rawTasks.filter((t) => scannedFileSet.has(t.file)) : rawTasks;
    estimateTasks = ctx.fileFilter
      ? allTasks.filter((t) => picomatch(ctx.fileFilter!)(t.file))
      : allTasks;
    if (ctx.fileFilter && estimateTasks.length === 0) {
      const cwdRel = relative(ctx.projectRoot, process.cwd()) || '.';
      throw new AnatolyError(
        `no files match --file '${ctx.fileFilter}'`,
        ERROR_CODES.FILE_NOT_FOUND,
        false,
        'fix the --file path — it is interpreted as a glob relative to the project root, not your current directory',
        undefined,
        false,
        [`project root: ${ctx.projectRoot}`, `cwd: ${cwdRel}`],
      );
    }
    const tokens = estimateTasksTokens(srcRoot, estimateTasks);
    estimateFiles = estimateTasks.length;
    return tokens;
  });
  // Safety: estimateTasks is always assigned inside runPhase before this point
  estimateTasks = estimateTasks!;

  // --- Phase: triage ---
  if (!ctx.triageEnabled) {
    pipelineRows.push({ phase: 'triage', detail: 'disabled (--no-triage)' });
  } else {
    await runPhase(ctx, 'triage', async () => {
      const tiers = { skip: 0, evaluate: 0 };
      const triageTasks = ctx.fileFilter
        ? allTasks.filter((t) => picomatch(ctx.fileFilter!)(t.file))
        : allTasks;

      for (const task of triageTasks) {
        const absPath = resolve(srcRoot, task.file);
        let source: string;
        try {
          source = readFileSync(absPath, 'utf-8');
        } catch {
          triageMap.set(task.file, { tier: 'evaluate', reason: 'unreadable' });
          tiers.evaluate++;
          continue;
        }

        const result = triageFile(task, source);
        triageMap.set(task.file, result);
        tiers[result.tier]++;
        rl?.info({ event: 'file_triage', phase: 'triage', file: task.file, tier: result.tier, reason: result.reason }, 'file triaged');
      }

      pipelineRows.push({ phase: 'triage', detail: `${tiers.evaluate} to evaluate (${tiers.skip} skipped)` });
      log.info({ phase: 'triage', runId: ctx.runId, skip: tiers.skip, evaluate: tiers.evaluate, total: allTasks.length }, 'triage summary');
      rl?.info({ phase: 'triage', runId: ctx.runId, skip: tiers.skip, evaluate: tiers.evaluate, total: allTasks.length }, 'triage summary');
    });
  }

  // --- Phase: RAG (structural counts: files + functions + chunks) ---
  let embedForecast: ReturnType<typeof estimateEmbedTokens> | undefined;
  if (ctx.enableRag) {
    const ragFiles = allTasks.filter((t) =>
      t.symbols.some((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
    ).length;
    const docsPath = getDocsDir(ctx.config);
    embedForecast = estimateEmbedTokens(srcRoot, allTasks, [docsPath, join('.anatoly', 'state', 'internal-docs')]);
    pipelineRows.push({
      phase: 'rag',
      detail: `${ragFiles} files · ${embedForecast.codeUnits} fns · ${embedForecast.nlpUnits} chunks`,
    });
  }

  // --- Phase: usage graph (computed for downstream pipeline; not displayed
  // in the run pre-confirmation table — opaque metric that lives in the
  // detailed `anatoly estimate` view). ---
  const usageGraph = buildUsageGraph(srcRoot, allTasks);
  const projectTree = buildProjectTree(allTasks.map((t) => t.file));
  const docsTree = buildDocsTree(srcRoot, getDocsDir(ctx.config));
  const internalDocsDir = anatolyPath(srcRoot, 'state/internal-docs');
  const internalDocsTree = buildDocsTree(srcRoot, join('.anatoly', 'state', 'internal-docs'));

  // --- Phase: docs (internal + project merged into one user-facing row) ---
  // Flag I/O uses ctx.projectRoot (where the doc ledger + docs live), not
  // srcRoot — they differ only under worktrees, where the ledger correctly
  // tracks the real doc location.
  const bootstrapNeeded = needsBootstrap(ctx.projectRoot);
  if (!isDocAxisActive(ctx) && bootstrapNeeded) {
    pipelineRows.push({ phase: 'docs', detail: 'skipped (documentation axis off)' });
  } else if (bootstrapNeeded) {
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

  // --- Forecast (single line: tokens · time · cost) ---
  const calibration = loadCalibration(ctx.projectRoot);
  const evalTasks = ctx.triageEnabled
    ? estimateTasks.filter(t => triageMap.get(t.file)?.tier === 'evaluate')
    : estimateTasks;
  // Always attach the resolved embedding model ids when present — including
  // local backends. Pricing-wise it's a no-op (calculateCost returns 0 for
  // unpriced models), but the display layer gets the real model id for
  // accurate labelling (jina-v2 768d, nomic-embed-code Q5_K_M, etc.).
  const embedWithModels = embedForecast
    ? {
        ...embedForecast,
        ...(handoff.resolvedModels
          ? { codeModel: handoff.resolvedModels.codeModel, nlpModel: handoff.resolvedModels.nlpModel }
          : {}),
      }
    : undefined;
  // Doc-gen forecast inputs: pageCount = idealPageCount approximation for
  // bootstrap, or the actual changed count for update. Skipped (pageCount = 0)
  // when nothing to do — forecastRun won't emit a doc step in that case.
  const docMode: 'bootstrap' | 'update' = bootstrapNeeded ? 'bootstrap' : 'update';
  const docPageCount = !isDocAxisActive(ctx) && bootstrapNeeded
    ? 0
    : docMode === 'bootstrap'
      ? Math.max(8, Math.ceil(allTasks.length / 12))
      : (docScanInternal?.changed ?? 0);
  const scaffoldingModel = ctx.config.agents.scaffolding ?? ctx.config.models.quality;

  const forecast = forecastRun({
    projectRoot: ctx.projectRoot,
    evalTasks,
    totalFiles: allTasks.length,
    axes: evaluators.map(e => ({ id: e.id, model: resolveAxisModel(e, ctx.config) })),
    ...(embedWithModels ? { embed: embedWithModels } : {}),
    ...(ctx.enableRag ? { summaryModel: resolveCodeSummaryModel(ctx.config) } : {}),
    ...(ctx.config.models.deliberation ? { deliberationModel: ctx.config.models.deliberation } : {}),
    ...(docPageCount > 0
      ? { docContext: { mode: docMode, pageCount: docPageCount, scaffoldingModel } }
      : {}),
    resolveBillingMode: (modelId: string) => {
      // Local embeddings (ONNX/GGUF, no API call) → 'local'. Anything else
      // looks up the provider's mode from config.providers.<provider>.mode.
      // Default 'api' when no entry exists.
      if (modelId === 'local') return 'local';
      const provider = extractProvider(modelId);
      const providers = ctx.config.providers as Record<string, { mode?: 'subscription' | 'api' } | undefined>;
      return providers[provider]?.mode === 'subscription' ? 'subscription' : 'api';
    },
    docConflictDetection: resolveDocMode(ctx.config) === 'full',
    calibration,
    concurrency: ctx.concurrency,
    ragEnabled: ctx.enableRag,
    deliberation: ctx.deliberation,
  });
  const calLabel = forecast.hasCalibration ? 'calibrated' : 'default';
  const estimateDetail =
    `${formatTokenCount(forecast.totalTokens)} tokens · ` +
    `${formatCalibratedTime(forecast.calibratedMin)} · ` +
    `$${forecast.totalCostUsd.toFixed(2)} (${calLabel})`;
  pipelineRows.push({ phase: 'estimate', detail: estimateDetail });

  // Surface actionable hints (missing init, lite RAG on capable hardware, …) before the summary.
  // Skip in dry-run / non-TTY / plain mode where interactive prompts make no sense.
  if (!ctx.dryRun && !ctx.plain && process.stdin.isTTY) {
    await runHints({
      projectRoot: ctx.projectRoot,
      ragEnabled: ctx.enableRag,
      resolvedRagMode: ctx.resolvedRagMode,
      hardware,
      telegramEnabled: ctx.config.notifications?.telegram?.enabled === true,
    });
  }

  // Story 55.9: Show pending doc conflicts hint at run start (FR16)
  {
    const pendingConflicts = countPendingDocConflicts(ctx.projectRoot);
    if (pendingConflicts > 0) {
      const hintMsg = `${pendingConflicts} doc conflict${pendingConflicts === 1 ? '' : 's'} pending — run \`anatoly docs arbitrate\` to resolve`;
      if (!ctx.plain && process.stdout.isTTY) {
        p.note(hintMsg, chalk.yellow('doc conflicts'));
      } else {
        process.stderr.write(`[doc-conflicts] ${hintMsg}\n`);
      }
    }
  }

  // Render setup summary table
  renderSetupTable({ project: projectInfo, config: configRows, models: modelsLeft, modelsRight, pipeline: pipelineRows }, ctx.plain);

  // Dry-run: show summary and exit before review
  if (ctx.dryRun) {
    const evalTasks = allTasks.filter((t) => triageMap.get(t.file)?.tier === 'evaluate');
    const { inputTokens, outputTokens } = estimateTasksTokens(srcRoot, allTasks);
    const estMinutes = estimateCalibratedMinutes(calibration, evalTasks.length, evaluators.map(e => e.id), ctx.concurrency, 0.75, { rag: ctx.enableRag, deliberation: ctx.deliberation });

    console.log('');
    console.log(chalk.bold('dry run') + ' — no files were reviewed');
    console.log('');
    console.log(`  files        ${allTasks.length}`);
    console.log(`  evaluate     ${evalTasks.length}`);
    console.log(`  skip         ${allTasks.length - evalTasks.length}`);
    console.log(`  tokens       ${formatTokenCount(inputTokens + outputTokens)}`);
    console.log(`  est. time    ${formatCalibratedTime(estMinutes)} (concurrency ${ctx.concurrency})`);
    console.log('');
    return { files: estimateFiles, tasks: allTasks, triageMap, usageGraph, depMeta, projectTree, docsTree, internalDocsTree, internalDocsDir };
  }

  // 3-choice prompt: proceed / open config / quit
  if (!ctx.interrupted) {
    await runEndOfSetupPrompt({
      isTTY: process.stdin.isTTY === true,
      defaultsSettings: ctx.defaultsSettings,
      projectRoot: ctx.projectRoot,
    });
  }

  // Story 49.3: visual transition between setup and audit phases.
  // Printed even for --defaults-settings; gated on --plain for text fallback.
  if (!ctx.interrupted && !ctx.dryRun) {
    printSetupToAuditTransition({ plain: ctx.plain });
  }

  handoff.allTasks = allTasks;
  handoff.triageMap = triageMap;

  return { files: estimateFiles, tasks: allTasks, triageMap, usageGraph, depMeta, projectTree, docsTree, internalDocsTree, internalDocsDir };
}
