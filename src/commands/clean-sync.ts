import type { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import chalk from 'chalk';

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
 * Check the shard line in report.md when all shard actions are done.
 * Finds `- [ ] [report.N.md]` and replaces with `- [x] [report.N.md]`.
 */
export function checkShardInIndex(indexContent: string, shardFilename: string): { content: string; changed: boolean } {
  // Match the shard checkbox line: - [ ] [report.N.md](...)
  const pattern = `- [ ] [${shardFilename}]`;
  if (!indexContent.includes(pattern)) return { content: indexContent, changed: false };
  return {
    content: indexContent.replace(pattern, `- [x] [${shardFilename}]`),
    changed: true,
  };
}

export function registerCleanSyncCommand(program: Command): void {
  program
    .command('clean-sync <report-file>')
    .description('Sync completed clean tasks from prd.json back to the shard and index reports')
    .action((reportFile: string) => {
      const projectRoot = process.cwd();
      const absShardPath = resolve(projectRoot, reportFile);

      if (!existsSync(absShardPath)) {
        console.error(chalk.red(`Shard file not found: ${reportFile}`));
        process.exit(1);
      }

      // Find prd.json in the corresponding fix directory
      const shardName = basename(reportFile, '.md');
      const cleanDir = resolve(projectRoot, '.anatoly', 'clean', shardName);
      const prdPath = join(cleanDir, 'prd.json');

      if (!existsSync(prdPath)) {
        console.error(chalk.red(`No prd.json found at ${prdPath}. Run \`anatoly clean ${reportFile}\` first.`));
        process.exit(1);
      }

      const prd: PrdFile = JSON.parse(readFileSync(prdPath, 'utf-8'));
      const completedStories = prd.userStories.filter((s) => s.passes);

      if (completedStories.length === 0) {
        console.log('No completed stories to sync.');
        return;
      }

      // Sync shard: check completed actions
      let shardContent = readFileSync(absShardPath, 'utf-8');
      let shardChecked = 0;

      for (const story of completedStories) {
        const result = checkAction(shardContent, story.actId);
        if (result.changed) {
          shardContent = result.content;
          shardChecked++;
        }
      }

      if (shardChecked > 0) {
        writeFileSync(absShardPath, shardContent);
      }

      // Sync index: find report.md in the same directory as the shard
      const shardDir = dirname(absShardPath);
      const indexPath = join(shardDir, 'report.md');
      let indexChecked = 0;
      let shardFullyDone = false;

      if (existsSync(indexPath)) {
        let indexContent = readFileSync(indexPath, 'utf-8');

        // Check completed actions in the Checklist section of report.md
        for (const story of completedStories) {
          const result = checkAction(indexContent, story.actId);
          if (result.changed) {
            indexContent = result.content;
            indexChecked++;
          }
        }

        // If ALL shard actions are checked, check the shard line in report.md
        if (allActionsChecked(shardContent)) {
          const shardFilename = basename(reportFile);
          const result = checkShardInIndex(indexContent, shardFilename);
          if (result.changed) {
            indexContent = result.content;
            shardFullyDone = true;
          }
        }

        if (indexChecked > 0 || shardFullyDone) {
          writeFileSync(indexPath, indexContent);
        }
      }

      console.log(chalk.green(`Synced ${shardChecked} action(s) in ${basename(reportFile)}`));
      if (indexChecked > 0) {
        console.log(chalk.green(`Synced ${indexChecked} action(s) in report.md Checklist`));
      }
      if (shardFullyDone) {
        console.log(chalk.green(`All actions done — checked shard in report.md`));
      }
    });
}
