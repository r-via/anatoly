// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRunDir, listRuns, readLatestPointer } from '../utils/run-id.js';
import { anatolyPath } from '../utils/anatoly-paths.js';
import { reviewsDir as runReviewsDir } from '../utils/run-layout.js';
import { ReviewFileSchema, type ReviewFile } from '../schemas/review.js';
import type { AxisId } from '../core/evaluation/contract.js';
import {
  writeProjectReview, writeProjectReviewAtHash, readRunConfig,
  createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot, pruneSnapshots,
} from '../core/run/index.js';
import { confirm, isInteractive } from '../utils/confirm.js';
import { computeAxisPromptHash } from '../core/run/axes-prompt-hash.js';
import { computeContentHash } from '../utils/cache.js';
import { loadConfig } from '../utils/config-loader.js';
import { getEnabledEvaluators, resolveAxisModel, type AxisEvaluator } from '../core/evaluation/index.js';
import type { Config } from '../schemas/config.js';
import { pkgVersion } from '../utils/version.js';

/**
 * Registers `anatoly cache <sub>` commands.
 *
 * Currently exposes `reseed`: rebuilds the project review cache from a
 * known-good prior run's reviews/ directory. The use case is recovering
 * from a run that corrupted the cache (e.g. a buggy --cache-refresh that
 * shrank coverage). Saves the cost of a full re-evaluation when the
 * source code has not changed since the source run.
 */
export function registerCacheCommand(program: Command): Command {
  const cacheCmd = program
    .command('cache')
    .description('Manage the project review cache (reseed; snapshot/restore in a follow-up)');

  cacheCmd
    .command('reseed [runId]')
    .description('Rebuild the project review cache from a prior run\'s reviews/ directory. Defaults to latest.')
    .option('--force', 'proceed even when the source run\'s anatoly version differs from the current binary')
    .option('--all', 'sweep ALL runs and reseed each file from the newest run whose review matches the current file content (maximizes valid coverage; requires provenance hashes)')
    .action(async (runId: string | undefined, opts: { force?: boolean; all?: boolean }) => {
      const projectRoot = resolve('.');
      if (opts.all) await runReseedAll(projectRoot);
      else await runReseed(projectRoot, runId, opts.force === true);
    });

  cacheCmd
    .command('snapshot')
    .description('Snapshot the current `.anatoly/cache/` to .anatoly/cache-snapshots/')
    .option('--note <text>', 'optional free-text note attached to the snapshot for later identification')
    .action(async (opts: { note?: string }) => {
      const projectRoot = resolve('.');
      runSnapshot(projectRoot, opts.note);
    });

  cacheCmd
    .command('list')
    .description('List all cache snapshots, newest first')
    .action(() => {
      const projectRoot = resolve('.');
      runList(projectRoot);
    });

  cacheCmd
    .command('restore <name>')
    .description('Restore a snapshot over the current cache. Auto-takes a pre-restore snapshot first.')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }) => {
      const projectRoot = resolve('.');
      await runRestore(projectRoot, name, opts.yes === true);
    });

  cacheCmd
    .command('prune')
    .description('Delete old snapshots, keeping the most recent N (default 5)')
    .option('--keep <n>', 'how many recent snapshots to keep', (v) => parseInt(v, 10), 5)
    .option('--name <name>', 'delete a specific snapshot by name instead of pruning')
    .action((opts: { keep: number; name?: string }) => {
      const projectRoot = resolve('.');
      runPrune(projectRoot, opts);
    });

  return cacheCmd;
}

interface ReseedStats {
  reseeded: number;
  skippedSourceMissing: number;
  skippedNotReviewable: number;
  legacyFallback: number;
  errors: Array<{ file: string; reason: string }>;
}

/**
 * Per-axis freshness keys ({prompt_hash, model_id}) under which the CURRENT
 * binary would store these axes — so a future read with the same prompts/model
 * hits. Shared by the single-run and --all reseed paths.
 */
function buildAxisMeta(
  axes: AxisId[],
  axisIdToEvaluator: Map<AxisId, AxisEvaluator>,
  config: Config,
): Record<string, { prompt_hash: string; model_id: string }> {
  const meta: Record<string, { prompt_hash: string; model_id: string }> = {};
  for (const a of axes) {
    const ev = axisIdToEvaluator.get(a);
    if (!ev) continue;
    const model = resolveAxisModel(ev, config);
    meta[a] = { prompt_hash: computeAxisPromptHash(a, model), model_id: model };
  }
  return meta;
}

async function runReseed(projectRoot: string, runId: string | undefined, force: boolean): Promise<void> {
  console.log(chalk.bold('anatoly — cache reseed'));

  const runDir = resolveRunDir(projectRoot, runId);
  if (!runDir) {
    const provided = runId ?? '(latest)';
    console.log(chalk.red(`  No run found for "${provided}".`));
    const runs = listRuns(projectRoot);
    if (runs.length > 0) {
      console.log(chalk.dim('  Available runs:'));
      for (const r of runs.slice(0, 10)) console.log(chalk.dim(`    ${r}`));
    }
    process.exitCode = 2;
    return;
  }
  const effectiveRunId = runId ?? readLatestPointer(anatolyPath(projectRoot, 'runs')) ?? '(latest)';

  const reviewsPath = runReviewsDir(runDir);
  if (!existsSync(reviewsPath)) {
    console.log(chalk.red(`  Run "${effectiveRunId}" has no reviews/ directory at ${reviewsPath}`));
    process.exitCode = 2;
    return;
  }

  // Anatoly-version sanity check: a different version may have produced
  // these reviews with different system prompts. The reseed writes the
  // cache under the CURRENT prompt hashes, so future reads will hit them
  // but the cached verdicts come from old prompts. Flag this loudly.
  const runCfg = readRunConfig(runDir);
  if (runCfg && runCfg.anatolyVersion !== pkgVersion && !force) {
    console.log(chalk.yellow(`  ⚠ Source run was produced by anatoly ${runCfg.anatolyVersion}; current is ${pkgVersion}.`));
    console.log(chalk.yellow('    Cached verdicts may be stale against current prompts.'));
    console.log(chalk.dim('    Re-run with --force to proceed anyway.'));
    process.exitCode = 2;
    return;
  }

  const config = loadConfig(projectRoot);
  const evaluators = getEnabledEvaluators(config);
  const axisIdToEvaluator = new Map(evaluators.map((e) => [e.id, e]));

  const stats: ReseedStats = {
    reseeded: 0,
    skippedSourceMissing: 0,
    skippedNotReviewable: 0,
    legacyFallback: 0,
    errors: [],
  };

  const reviewFiles = readdirSync(reviewsPath).filter((f) => f.endsWith('.rev.json'));
  console.log(chalk.dim(`  Source run: ${effectiveRunId} (${reviewFiles.length} review files)`));

  for (const reviewFile of reviewFiles) {
    const reviewPath = join(reviewsPath, reviewFile);
    let parsed: ReviewFile;
    try {
      const raw = JSON.parse(readFileSync(reviewPath, 'utf-8'));
      parsed = ReviewFileSchema.parse(raw);
    } catch (err) {
      stats.errors.push({ file: reviewFile, reason: `parse failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const sourcePath = join(projectRoot, parsed.file);
    if (!existsSync(sourcePath)) {
      stats.skippedSourceMissing++;
      continue;
    }

    // Axes covered = axes with at least one non-`-` per-symbol verdict.
    // A review with all symbols at `-` for an axis means that axis was
    // never evaluated for this file; we should not advertise it as cached.
    const axes = computeCoveredAxes(parsed);
    if (axes.length === 0) {
      stats.skippedNotReviewable++;
      continue;
    }

    const axisMeta = buildAxisMeta(axes, axisIdToEvaluator, config);

    try {
      // Provenance: key the cache by the SOURCE content the review describes
      // (review.content_hash), so a future run reuses it only when the file
      // still holds that exact content. Reviews produced before this field
      // existed fall back to the current file content (the re-stamp caveat in
      // the closing note applies to those).
      const srcHash = parsed.content_hash;
      if (srcHash) {
        writeProjectReviewAtHash(projectRoot, parsed, srcHash, axisMeta, axes);
      } else {
        writeProjectReview(projectRoot, parsed, readFileSync(sourcePath, 'utf-8'), axisMeta, axes);
        stats.legacyFallback++;
      }
      stats.reseeded++;
    } catch (err) {
      stats.errors.push({ file: reviewFile, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log('');
  console.log(chalk.green(`  ✓ ${stats.reseeded} review${stats.reseeded === 1 ? '' : 's'} reseeded into the cache`));
  if (stats.skippedSourceMissing > 0) {
    console.log(chalk.dim(`  ↷ ${stats.skippedSourceMissing} skipped (source file no longer exists)`));
  }
  if (stats.skippedNotReviewable > 0) {
    console.log(chalk.dim(`  ↷ ${stats.skippedNotReviewable} skipped (review has no axis coverage)`));
  }
  if (stats.errors.length > 0) {
    console.log(chalk.red(`  ✖ ${stats.errors.length} error${stats.errors.length === 1 ? '' : 's'}:`));
    for (const e of stats.errors.slice(0, 5)) {
      console.log(chalk.red(`    ${e.file}: ${e.reason}`));
    }
    if (stats.errors.length > 5) console.log(chalk.red(`    ... and ${stats.errors.length - 5} more`));
  }
  if (stats.legacyFallback > 0) {
    console.log('');
    console.log(chalk.dim(`  Note: ${stats.legacyFallback} review(s) lacked a provenance hash and were keyed by`));
    console.log(chalk.dim('  CURRENT file content. If such a file was modified since the source run, its'));
    console.log(chalk.dim('  entry describes the older version — re-run with that file changed, or wait for'));
    console.log(chalk.dim('  the next anatoly run to re-evaluate it. No silent corruption either way.'));
  }
}

/**
 * `cache reseed --all`: sweep every run and reseed each file from the newest
 * run whose review describes the file's CURRENT content (max axis coverage on
 * ties). Only provenance-bearing reviews are eligible, so every reseeded entry
 * is guaranteed to match the current file (no re-stamp risk). Useful when the
 * latest run is partial/failed and earlier runs still cover the rest.
 */
async function runReseedAll(projectRoot: string): Promise<void> {
  console.log(chalk.bold('anatoly — cache reseed (--all)'));

  const config = loadConfig(projectRoot);
  const evaluators = getEnabledEvaluators(config);
  const axisIdToEvaluator = new Map(evaluators.map((e) => [e.id, e]));

  // Newest run first: ids are timestamped (YYYY-MM-DD_HHMMSS), lexicographically sortable.
  const runIds = [...listRuns(projectRoot)].sort().reverse();
  if (runIds.length === 0) {
    console.log(chalk.red('  No runs found.'));
    process.exitCode = 2;
    return;
  }

  const currentHash = new Map<string, string | null>(); // file -> current content hash (null = gone)
  const hashOf = (file: string): string | null => {
    if (currentHash.has(file)) return currentHash.get(file)!;
    let h: string | null = null;
    try { h = computeContentHash(readFileSync(join(projectRoot, file), 'utf-8')); } catch { h = null; }
    currentHash.set(file, h);
    return h;
  };

  // file -> best provenance-matching review (max coverage, newest on tie)
  const chosen = new Map<string, { review: ReviewFile; axes: AxisId[]; srcHash: string }>();
  let scanned = 0, noProvenance = 0, contentMismatch = 0;

  for (const rid of runIds) {
    const rdir = resolveRunDir(projectRoot, rid);
    if (!rdir) continue;
    const reviewsPath = runReviewsDir(rdir);
    if (!existsSync(reviewsPath)) continue;
    for (const rf of readdirSync(reviewsPath).filter((f) => f.endsWith('.rev.json'))) {
      let parsed: ReviewFile;
      try { parsed = ReviewFileSchema.parse(JSON.parse(readFileSync(join(reviewsPath, rf), 'utf-8'))); }
      catch { continue; }
      scanned++;
      const srcHash = parsed.content_hash;
      if (!srcHash) { noProvenance++; continue; }       // can't validate without provenance
      if (hashOf(parsed.file) !== srcHash) { contentMismatch++; continue; } // describes a different version
      const axes = computeCoveredAxes(parsed);
      if (axes.length === 0) continue;
      const prev = chosen.get(parsed.file);
      // Newest-first iteration: first-seen wins ties; replace only on strictly
      // greater coverage so a full run beats a later partial run at same content.
      if (!prev || axes.length > prev.axes.length) {
        chosen.set(parsed.file, { review: parsed, axes, srcHash });
      }
    }
  }

  let reseeded = 0;
  for (const { review, axes, srcHash } of chosen.values()) {
    try {
      writeProjectReviewAtHash(projectRoot, review, srcHash, buildAxisMeta(axes, axisIdToEvaluator, config), axes);
      reseeded++;
    } catch { /* non-fatal per file */ }
  }

  console.log(chalk.dim(`  Swept ${runIds.length} run(s), ${scanned} review file(s).`));
  console.log('');
  console.log(chalk.green(`  ✓ ${reseeded} file(s) reseeded (newest content-matching review each)`));
  if (noProvenance > 0) console.log(chalk.dim(`  ↷ ${noProvenance} review(s) skipped (no provenance hash — pre-upgrade)`));
  if (contentMismatch > 0) console.log(chalk.dim(`  ↷ ${contentMismatch} review(s) skipped (describe an older version of the file)`));
}

/**
 * Compute the set of axes that the review actually covered. An axis is
 * "covered" iff at least one symbol carries a non-`-` verdict for it.
 * The `-` sentinel means the axis was skipped (by --axes filter) or
 * crashed; treating it as "covered" would lie to the index.
 */
function computeCoveredAxes(review: ReviewFile): AxisId[] {
  const covered = new Set<AxisId>();
  for (const s of review.symbols) {
    if (s.correction !== '-') covered.add('correction');
    if (s.overengineering !== '-') covered.add('overengineering');
    if (s.utility !== '-') covered.add('utility');
    if (s.duplication !== '-') covered.add('duplication');
    if (s.tests !== '-') covered.add('tests');
    if (s.documentation !== '-') covered.add('documentation');
  }
  if (review.best_practices) covered.add('best_practices');
  return [...covered].sort();
}

// ---------------------------------------------------------------------------
// Snapshot / restore actions
// ---------------------------------------------------------------------------

function runSnapshot(projectRoot: string, note: string | undefined): void {
  console.log(chalk.bold('anatoly — cache snapshot'));
  const meta = createSnapshot({
    projectRoot,
    reason: 'manual',
    note,
    triggerCommand: process.argv.slice(1).join(' '),
  });
  if (!meta) {
    console.log(chalk.yellow('  No .anatoly/cache/ directory found — nothing to snapshot.'));
    return;
  }
  console.log(chalk.green(`  ✓ ${meta.name}`));
  console.log(chalk.dim(`    ${meta.fileCount} files, ${formatBytes(meta.sizeBytes)}`));
  if (meta.gitCommit) console.log(chalk.dim(`    git commit ${meta.gitCommit.slice(0, 8)}`));
}

function runList(projectRoot: string): void {
  console.log(chalk.bold('anatoly — cache snapshots'));
  const snapshots = listSnapshots(projectRoot);
  if (snapshots.length === 0) {
    console.log(chalk.dim('  No snapshots yet. Take one with `anatoly cache snapshot`.'));
    return;
  }
  for (const s of snapshots) {
    console.log('');
    console.log(`  ${chalk.bold(s.name)}`);
    console.log(`    ${chalk.dim('reason:')}   ${s.reason}${s.note ? ` (${s.note})` : ''}`);
    console.log(`    ${chalk.dim('created:')}  ${s.createdAt}`);
    console.log(`    ${chalk.dim('size:')}     ${s.fileCount} files, ${formatBytes(s.sizeBytes)} (${s.format === 'tar' ? 'tar.gz' : 'directory'})`);
    if (s.gitCommit) console.log(`    ${chalk.dim('git:')}      ${s.gitCommit.slice(0, 8)}`);
    if (s.anatolyVersion) console.log(`    ${chalk.dim('anatoly:')}  ${s.anatolyVersion}`);
    if (s.triggerCommand) console.log(`    ${chalk.dim('command:')}  ${s.triggerCommand}`);
  }
}

async function runRestore(projectRoot: string, name: string, skipConfirm: boolean): Promise<void> {
  console.log(chalk.bold('anatoly — cache restore'));

  const snapshots = listSnapshots(projectRoot);
  const target = snapshots.find((s) => s.name === name);
  if (!target) {
    console.log(chalk.red(`  Snapshot "${name}" not found.`));
    if (snapshots.length > 0) {
      console.log(chalk.dim('  Available:'));
      for (const s of snapshots.slice(0, 5)) console.log(chalk.dim(`    ${s.name}`));
    }
    process.exitCode = 2;
    return;
  }

  console.log(`  Restore ${chalk.bold(target.name)} (${target.fileCount} files, ${formatBytes(target.sizeBytes)})`);
  console.log(chalk.dim('  This will overwrite the current `.anatoly/cache/`.'));
  console.log(chalk.dim('  A pre-restore snapshot of the current cache is taken automatically.'));

  if (!skipConfirm) {
    if (!isInteractive()) {
      console.log(chalk.red('  Refusing to restore non-interactively without --yes'));
      process.exitCode = 1;
      return;
    }
    const ok = await confirm('  Proceed?');
    if (!ok) {
      console.log('  cancelled.');
      return;
    }
  }

  try {
    const result = restoreSnapshot(projectRoot, name);
    console.log(chalk.green(`  ✓ ${result.restored} files restored`));
    if (result.preRestoreSnapshot) {
      console.log(chalk.dim(`  ↺ pre-restore snapshot: ${result.preRestoreSnapshot.name}`));
    }
  } catch (err) {
    console.log(chalk.red(`  Restore failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  }
}

function runPrune(projectRoot: string, opts: { keep: number; name?: string }): void {
  console.log(chalk.bold('anatoly — cache prune'));
  if (opts.name) {
    if (deleteSnapshot(projectRoot, opts.name)) {
      console.log(chalk.green(`  ✓ deleted ${opts.name}`));
    } else {
      console.log(chalk.red(`  Snapshot "${opts.name}" not found.`));
      process.exitCode = 2;
    }
    return;
  }
  const result = pruneSnapshots(projectRoot, opts.keep);
  console.log(chalk.dim(`  kept ${result.kept} snapshot${result.kept === 1 ? '' : 's'}`));
  if (result.pruned.length === 0) {
    console.log(chalk.dim('  nothing to prune.'));
    return;
  }
  console.log(chalk.green(`  ✓ pruned ${result.pruned.length} snapshot${result.pruned.length === 1 ? '' : 's'}:`));
  for (const name of result.pruned) console.log(chalk.dim(`    ${name}`));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

