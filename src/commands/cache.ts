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
import { writeProjectReview, readRunConfig } from '../core/run/index.js';
import { computeAxesPromptHash } from '../core/run/axes-prompt-hash.js';
import { loadConfig } from '../utils/config-loader.js';
import { getEnabledEvaluators, resolveAxisModel } from '../core/evaluation/index.js';
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
    .action(async (runId: string | undefined, opts: { force?: boolean }) => {
      const projectRoot = resolve('.');
      await runReseed(projectRoot, runId, opts.force === true);
    });

  return cacheCmd;
}

interface ReseedStats {
  reseeded: number;
  skippedSourceMissing: number;
  skippedNotReviewable: number;
  errors: Array<{ file: string; reason: string }>;
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

    // Compute the prompt hash + model id under which the CURRENT binary
    // would store this review. Future reads use these same values, so the
    // cache lookup will match. (The cached verdicts may be from older
    // prompts — the version-mismatch warning above is the user-facing
    // guard for that.)
    const modelId = axes
      .map((a) => axisIdToEvaluator.get(a))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
      .map((e) => resolveAxisModel(e, config))
      .sort()
      .join('+');
    const promptHash = computeAxesPromptHash(axes, modelId);

    try {
      const fileContent = readFileSync(sourcePath, 'utf-8');
      writeProjectReview(projectRoot, parsed, fileContent, promptHash, modelId, axes);
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
  console.log('');
  console.log(chalk.dim('  Note: cache content hash uses CURRENT file content. Files modified since'));
  console.log(chalk.dim('  the source run get a cache entry that will not match anything until the'));
  console.log(chalk.dim('  next anatoly run re-evaluates them — no silent corruption.'));
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
