// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { existsSync, cpSync, readFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRunDir } from '../utils/run-id.js';

const REPORTS_REPO = 'r-via/anatoly-reports';
const REPORTS_REPO_URL = `https://github.com/${REPORTS_REPO}.git`;

/** Registers the `report upstream` CLI sub-command. */
export function registerReportUpstreamCommand(program: Command): void {
  program
    .command('upstream')
    .description('Publish report to anatoly-reports and open an issue on the upstream repo')
    .option('--run <id>', 'use a specific run (default: latest)')
    .option('--dry', 'show what would happen without publishing')
    .option('--no-issue', 'push report only, skip opening an issue')
    .action(async (cmdOpts: { run?: string; dry?: boolean; issue?: boolean }) => {
      const projectRoot = process.cwd();

      // 1. Resolve run directory
      const runDir = resolveRunDir(projectRoot, cmdOpts.run);
      if (!runDir) {
        console.error(chalk.red('No run found. Run `anatoly run` first.'));
        process.exitCode = 1;
        return;
      }

      const reportPath = join(runDir, 'report.md');
      if (!existsSync(reportPath)) {
        console.error(chalk.red(`No report.md found in ${runDir}. Run \`anatoly report\` first.`));
        process.exitCode = 1;
        return;
      }

      // 2. Detect upstream repo
      const upstream = detectUpstream(projectRoot);
      if (!upstream) {
        console.error(chalk.red('Could not detect upstream repository.'));
        console.error(chalk.yellow('Add an "upstream" remote or run from a GitHub fork.'));
        process.exitCode = 1;
        return;
      }

      // 3. Determine report path in anatoly-reports
      const runId = basename(runDir);
      const projectSlug = upstream.owner + '--' + upstream.repo;
      const reportSubdir = join(projectSlug, runId);

      console.log(chalk.bold('\nAnatoly Report Upstream'));
      console.log(`  Target repo:   ${chalk.cyan(upstream.owner + '/' + upstream.repo)}`);
      console.log(`  Report path:   ${chalk.cyan(reportSubdir)}`);
      console.log(`  Reports repo:  ${chalk.cyan(REPORTS_REPO)}`);
      console.log('');

      if (cmdOpts.dry) {
        console.log(chalk.yellow('Dry run — no changes will be made.'));
        return;
      }

      // 4. Clone anatoly-reports to temp dir
      const tmpDir = join(tmpdir(), `anatoly-reports-${Date.now()}`);
      try {
        console.log('Cloning anatoly-reports...');
        execSync(`git clone --depth 1 ${REPORTS_REPO_URL} "${tmpDir}"`, { stdio: 'pipe' });

        // 5. Copy report files
        const destDir = join(tmpDir, reportSubdir);
        mkdirSync(destDir, { recursive: true });

        // Copy report.md
        cpSync(reportPath, join(destDir, 'report.md'));

        // Copy axes/ directory if present
        const axesDir = join(runDir, 'axes');
        if (existsSync(axesDir)) {
          cpSync(axesDir, join(destDir, 'axes'), { recursive: true });
        }

        // 6. Commit and push
        console.log('Pushing report...');
        execSync(`git -C "${tmpDir}" add .`, { stdio: 'pipe' });

        // Check if there are staged changes
        const diff = execSync(`git -C "${tmpDir}" diff --cached --quiet || echo changed`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        }).trim();

        const reportUrl = `https://github.com/${REPORTS_REPO}/blob/main/${reportSubdir}/report.md`;

        if (diff === 'changed') {
          execSync(
            `git -C "${tmpDir}" commit -m "audit: ${upstream.owner}/${upstream.repo} (${runId})"`,
            { stdio: 'pipe' },
          );
          execSync(`git -C "${tmpDir}" push`, { stdio: 'pipe' });
          console.log(chalk.green(`Report published: ${reportUrl}`));
        } else {
          console.log(chalk.yellow(`Report already published: ${reportUrl}`));
        }

        // 8. Open issue on upstream
        if (cmdOpts.issue !== false) {
          console.log('');
          const issueBody = buildIssueBody(reportPath, reportUrl);
          const issueUrl = createIssue(upstream, issueBody);
          if (issueUrl) {
            console.log(chalk.green(`Issue created: ${issueUrl}`));
          }
        }
      } finally {
        // Cleanup temp dir
        try {
          execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' });
        } catch {
          // ignore cleanup errors
        }
      }

      console.log('');
    });
}

interface UpstreamRepo {
  owner: string;
  repo: string;
  full: string;
}

function detectUpstream(projectRoot: string): UpstreamRepo | null {
  // Try "upstream" remote first
  const upstream = getRemoteNwo(projectRoot, 'upstream');
  if (upstream) return upstream;

  // Try to detect via gh: if origin is a fork, get the parent
  try {
    const rawJson = execSync('gh repo view --json parent', {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
    const parsed = JSON.parse(rawJson);
    if (parsed.parent?.owner?.login && parsed.parent?.name) {
      const owner = parsed.parent.owner.login;
      const repo = parsed.parent.name;
      return { owner, repo, full: `${owner}/${repo}` };
    }
  } catch {
    // gh not available or not a fork
  }

  // Fallback: use origin itself (for repos you own but still want to report on)
  return getRemoteNwo(projectRoot, 'origin');
}

function getRemoteNwo(projectRoot: string, remote: string): UpstreamRepo | null {
  try {
    const url = execSync(`git remote get-url ${remote}`, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();

    // Parse GitHub URL: https://github.com/owner/repo.git or git@github.com:owner/repo.git
    const SAFE_NWO = /^[a-zA-Z0-9._-]+$/;
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch && SAFE_NWO.test(httpsMatch[1]) && SAFE_NWO.test(httpsMatch[2])) {
      return { owner: httpsMatch[1], repo: httpsMatch[2], full: `${httpsMatch[1]}/${httpsMatch[2]}` };
    }
    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch && SAFE_NWO.test(sshMatch[1]) && SAFE_NWO.test(sshMatch[2])) {
      return { owner: sshMatch[1], repo: sshMatch[2], full: `${sshMatch[1]}/${sshMatch[2]}` };
    }
  } catch {
    // remote doesn't exist
  }
  return null;
}

// GitHub renders relative markdown links from the file's directory, so no rewrite needed.

function buildIssueBody(localReportPath: string, reportUrl: string): string {
  const report = readFileSync(localReportPath, 'utf-8');
  const lines: string[] = [];

  lines.push('Hey! My name is Rémi. I created [Anatoly](https://github.com/r-via/anatoly), a free open-source audit tool for codebases. It helps clean up vibe-coded projects by checking for common issues across multiple axes — things like dead code, duplications, missing docs, correctness bugs, over-engineering, test gaps, and best practices.');
  lines.push('');
  lines.push('I ran it on your project and here is the report. Hopefully you will find something useful in there! Feel free to reach out if you have any questions or feedback.');
  lines.push('');

  // Extract Executive Summary + Severity table (everything between ## Executive Summary and the next ##)
  const summaryMatch = report.match(/## Executive Summary\n\n([\s\S]*?)(?=\n## )/);
  if (summaryMatch) {
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(summaryMatch[1].trim());
    lines.push('');
  }

  // Extract Axis Summary
  const axisSummaryMatch = report.match(/## Axis Summary\n\n([\s\S]*?)(?=\n## )/);
  if (axisSummaryMatch) {
    lines.push('## Axis Summary');
    lines.push('');
    lines.push(axisSummaryMatch[1].trim());
    lines.push('');
  }

  // Link to full report
  lines.push('---');
  lines.push('');
  lines.push(`**[View full report](${reportUrl})**`);
  lines.push('');
  lines.push('*Generated by [Anatoly](https://github.com/r-via/anatoly) — Deep Audit Agent for codebases*');

  return lines.join('\n');
}

function createIssue(upstream: UpstreamRepo, body: string): string | null {
  try {
    // Always use --body-file stdin to avoid shell injection via body content
    const result = execSync(
      `gh issue create --repo "${upstream.full}" --title "Anatoly Audit Report" --body-file -`,
      { input: body, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    ).trim();
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to create issue: ${msg}`));
    return null;
  }
}
