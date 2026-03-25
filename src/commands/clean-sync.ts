// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import { isLockActive } from '../utils/lock.js';
import { resolveRunDir } from '../utils/run-id.js';
import { REPORT_AXIS_IDS, type ReportAxisId } from '../core/reporter.js';
import { DISCOVERED_ACT_ID } from './clean.js';

interface PrdStory {
  id: string;
  actId: string;
  title: string;
  passes: boolean;
}

interface PrdFile {
  userStories: PrdStory[];
}

/**
 * Check a single checkbox in file content by its ACT-ID.
 * Replaces `- [ ] <!-- ACT-xxx -->` with `- [x] <!-- ACT-xxx -->`.
 * Returns the updated content and whether a replacement was made.
 */
export function checkAction(content: string, actId: string): { content: string; changed: boolean } {
  const pattern = `- [ ] <!-- ${actId} -->`;
  if (!content.includes(pattern)) return { content, changed: false };
  return {
    content: content.replaceAll(pattern, `- [x] <!-- ${actId} -->`),
    changed: true,
  };
}

/**
 * Check if all ACT checkboxes in a file section are checked.
 */
export function allActionsChecked(content: string): boolean {
  const unchecked = /^- \[ \] <!-- ACT-[a-f0-9]+-\d+ -->/m;
  return !unchecked.test(content);
}

/**
 * Check the shard line in an axis index when all shard actions are done.
 * Finds `- [ ] [shard.N.md]` and replaces with `- [x] [shard.N.md]`.
 */
export function checkShardInIndex(indexContent: string, shardFilename: string): { content: string; changed: boolean } {
  const pattern = `- [ ] [${shardFilename}]`;
  if (!indexContent.includes(pattern)) return { content: indexContent, changed: false };
  return {
    content: indexContent.replace(pattern, `- [x] [${shardFilename}]`),
    changed: true,
  };
}

/**
 * Sync completed stories for a single axis.
 *
 * Iterates over every `shard.*.md` file in the axis directory, checks off
 * ACT-ID checkboxes that correspond to completed stories, and updates the
 * axis index when a shard becomes fully checked.
 *
 * @param runDir - Absolute path to the resolved run directory.
 * @param axis - The report axis identifier to sync (e.g. `"documentation"`).
 * @param completedStories - PRD stories whose `passes` flag is `true` and
 *   whose checkboxes should be marked as done in the shard files.
 * @returns An object with `shardChecked` (number of newly checked actions
 *   across all shards) and `allDone` (`true` when every shard in the axis
 *   has all its checkboxes checked).
 */
function syncAxis(
  runDir: string,
  axis: ReportAxisId,
  completedStories: PrdStory[],
): { shardChecked: number; allDone: boolean } {
  const axisDir = join(runDir, 'axes', axis);
  if (!existsSync(axisDir)) return { shardChecked: 0, allDone: false };

  const shardFiles = readdirSync(axisDir)
    .filter((f) => f.startsWith('shard.') && f.endsWith('.md'))
    .sort();

  let totalChecked = 0;
  let allShardsDone = true;

  for (const shardFile of shardFiles) {
    const shardPath = join(axisDir, shardFile);
    let content = readFileSync(shardPath, 'utf-8');
    let checkedInShard = 0;

    for (const story of completedStories) {
      const result = checkAction(content, story.actId);
      if (result.changed) {
        content = result.content;
        checkedInShard++;
      }
    }

    if (checkedInShard > 0) {
      writeFileSync(shardPath, content);
      totalChecked += checkedInShard;
    }

    // Check if this shard is fully done
    if (!allActionsChecked(content)) {
      allShardsDone = false;
    } else {
      // Check the shard line in the axis index
      const indexPath = join(axisDir, 'index.md');
      if (existsSync(indexPath)) {
        let indexContent = readFileSync(indexPath, 'utf-8');
        const result = checkShardInIndex(indexContent, shardFile);
        if (result.changed) {
          indexContent = result.content;
          writeFileSync(indexPath, indexContent);
        }
      }
    }
  }

  return { shardChecked: totalChecked, allDone: allShardsDone };
}

/**
 * Registers the `clean-sync` CLI sub-command on the given Commander program.
 *
 * The sub-command syncs completed user stories from a `prd.json` back to the
 * axis shard reports by checking off their ACT-ID checkboxes. Accepts a single
 * axis name or `"all"` to sync every axis at once.
 *
 * @param program - The root Commander {@link Command} instance to attach the sub-command to.
 */
export function registerCleanSyncCommand(program: Command): void {
  program
    .command('clean-sync <axis>')
    .description('Sync completed clean tasks from prd.json back to axis reports (axis name or "all")')
    .action((axis: string) => {
      const projectRoot = process.cwd();

      if (isLockActive(projectRoot)) {
        console.error(chalk.red('A run is currently in progress. Wait for it to finish before running this command.'));
        process.exitCode = 1;
        return;
      }

      const runDir = resolveRunDir(projectRoot);
      if (!runDir) {
        console.error(chalk.red('No run found. Run `anatoly run` first.'));
        process.exit(1);
      }

      // Determine axes to sync
      const axes: ReportAxisId[] = axis === 'all'
        ? [...REPORT_AXIS_IDS]
        : [axis as ReportAxisId];

      if (axis !== 'all' && !REPORT_AXIS_IDS.includes(axis as ReportAxisId)) {
        console.error(chalk.red(`Unknown axis: ${axis}`));
        console.error(`Valid axes: ${REPORT_AXIS_IDS.join(', ')}, all`);
        process.exit(1);
      }

      // Find prd.json
      const cleanDir = resolve(projectRoot, '.anatoly', 'clean', axis);
      const prdPath = join(cleanDir, 'prd.json');

      if (!existsSync(prdPath)) {
        console.error(chalk.red(`No prd.json found at ${prdPath}. Run \`anatoly clean ${axis}\` first.`));
        process.exit(1);
      }

      const prd: PrdFile = JSON.parse(readFileSync(prdPath, 'utf-8'));
      const completedStories = prd.userStories.filter((s) => s.passes && s.actId !== DISCOVERED_ACT_ID);

      if (completedStories.length === 0) {
        console.log('No completed stories to sync.');
        return;
      }

      let totalChecked = 0;
      const fullyDoneAxes: string[] = [];

      for (const axisId of axes) {
        const result = syncAxis(runDir, axisId, completedStories);
        totalChecked += result.shardChecked;
        if (result.allDone) fullyDoneAxes.push(axisId);
      }

      console.log(chalk.green(`Synced ${totalChecked} action(s) across ${axes.length} axis/axes`));
      if (fullyDoneAxes.length > 0) {
        console.log(chalk.green(`Fully completed axes: ${fullyDoneAxes.join(', ')}`));
      }
    });
}
