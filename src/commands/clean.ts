// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import chalk from 'chalk';
import { isLockActive } from '../utils/lock.js';
import { resolveRunDir } from '../utils/run-id.js';
import { loadConfig } from '../utils/config-loader.js';
import { REPORT_AXIS_IDS, type ReportAxisId } from '../core/reporter.js';

/**
 * A parsed unchecked action from a shard report.
 */
export interface CleanItem {
  actId: string;
  severity: string;
  source: string;
  file: string;
  description: string;
  symbol?: string;
}

/** Sentinel actId for stories discovered by the agent during iteration (not from audit findings). */
export const DISCOVERED_ACT_ID = 'DISCOVERED';

const ACT_LINE_RE = /^- \[ \] <!-- (ACT-[a-f0-9]+-\d+) --> /;
const BRACKET_RE = /\*\*\[([^\]]+)\]\*\*/;
const FILE_RE = /`([^`]+)`:/;
const SYMBOL_RE = /\(`([^`]+)`\)/;
const LINES_RE = /\[[^\]]+\]$/;
const SEVERITY_SET = new Set(['high', 'medium', 'low']);
const EFFORT_SET = new Set(['trivial', 'small', 'large']);

/**
 * Parse unchecked checkboxes from a shard (or index) report file.
 * Returns only unchecked `- [ ]` actions with valid ACT-IDs.
 *
 * @param content - Raw Markdown content of a shard report file containing
 *   checkbox action lines (e.g. `- [ ] <!-- ACT-xxx --> ...`).
 * @returns An array of {@link CleanItem} objects, one per unchecked action
 *   that has a valid ACT-ID, severity, source file, and description.
 */
export function parseUncheckedActions(content: string): CleanItem[] {
  const items: CleanItem[] = [];

  for (const line of content.split('\n')) {
    const actMatch = line.match(ACT_LINE_RE);
    if (!actMatch) continue;
    const actId = actMatch[1];

    const bracketMatch = line.match(BRACKET_RE);
    if (!bracketMatch) continue;
    const parts = bracketMatch[1].split('\u00B7').map((s) => s.trim());

    let source = '';
    let severity = 'medium';
    for (const part of parts) {
      if (SEVERITY_SET.has(part)) severity = part;
      else if (!EFFORT_SET.has(part)) source = part;
    }

    const fileMatch = line.match(FILE_RE);
    if (!fileMatch) continue;
    const file = fileMatch[1];

    // Description: after `file`: ... up to optional (`symbol`) or [lines]
    const descStart = line.indexOf(fileMatch[0]) + fileMatch[0].length;
    let rest = line.slice(descStart).trim();

    const symMatch = rest.match(SYMBOL_RE);
    const symbol = symMatch ? symMatch[1] : undefined;
    if (symMatch) rest = rest.replace(symMatch[0], '').trim();
    rest = rest.replace(LINES_RE, '').trim();

    items.push({ actId, source, severity, file, description: rest, symbol });
  }

  return items;
}

/**
 * Resolve the axis shard files for a given axis in the latest run.
 * Returns the contents of all shard.*.md files concatenated.
 */
function resolveAxisShards(projectRoot: string, axis: ReportAxisId): string | null {
  const runDir = resolveRunDir(projectRoot);
  if (!runDir) return null;

  const axisDir = join(runDir, 'axes', axis);
  if (!existsSync(axisDir)) return null;

  const shardFiles = readdirSync(axisDir)
    .filter((f) => f.startsWith('shard.') && f.endsWith('.md'))
    .sort();

  if (shardFiles.length === 0) return null;

  return shardFiles.map((f) => readFileSync(join(axisDir, f), 'utf-8')).join('\n');
}

function generatePrd(cleanName: string, items: CleanItem[]): object {
  return {
    project: 'Anatoly Clean',
    branchName: `clean/anatoly-${cleanName}`,
    description: `Automated remediation of ${items.length} findings from ${cleanName}`,
    userStories: items.map((item, i) => ({
      id: `FIX-${String(i + 1).padStart(3, '0')}`,
      actId: item.actId,
      title: `Fix: ${item.description}`,
      description: `Resolve ${item.severity} finding in \`${item.file}\`${item.symbol ? ` (symbol: \`${item.symbol}\`)` : ''}: ${item.description}`,
      acceptanceCriteria: [
        'The issue described in the finding is resolved',
        '`npm run build` succeeds',
        '`npm test` passes',
      ],
      priority: i + 1,
      passes: false,
      notes: item.source ? `Source axis: ${item.source}` : '',
    })),
  };
}

function generateClaudeMd(cleanName: string, cleanDir: string, projectRoot: string): string {
  const runDir = resolveRunDir(projectRoot);
  const reviewsPath = runDir ? `${runDir}/reviews/` : '.anatoly/runs/*/reviews/';
  return `# Clean Agent Instructions

## Role

You are an autonomous TypeScript correction agent working in a Ralph loop.
Your job is to clean audit findings one at a time.

## Key Files

| File | Path | Purpose |
|------|------|---------|
| PRD | \`${cleanDir}/prd.json\` | User stories — pick the first with \`"passes": false\` |
| Progress | \`${cleanDir}/progress.txt\` | Learnings log — **read Codebase Patterns first** |
| Reviews | \`${reviewsPath}\` | Per-file \`.rev.md\` with axis-by-axis detail |

## Workflow

1. Read \`${cleanDir}/prd.json\` — find the first user story where \`"passes": false\`
2. Read \`${cleanDir}/progress.txt\` — check the **Codebase Patterns** section first for learnings from previous iterations
3. Check you're on the correct branch from PRD \`branchName\`. If not, check it out or create from main.
4. Read the corresponding \`.rev.md\` file for detailed context on the finding
5. Fix the issue in the source code
6. Verify: \`npm run build && npm test\`
7. Commit: \`git commit -m "fix: [FIX-NNN] - short description"\`
8. Update \`${cleanDir}/prd.json\`: set \`"passes": true\` for the completed story
9. Append your progress to \`${cleanDir}/progress.txt\` (see format below)
10. If all stories have \`"passes": true\`, output \`<promise>COMPLETE</promise>\`

## Constraints

- Only modify files matching: \`src/**/*.ts\`, \`test/**/*.ts\`, \`*.test.ts\`
- One fix per iteration — do not batch multiple stories
- Always verify \`npm run build && npm test\` before committing
- Read the \`.rev.md\` transcript for full axis-by-axis context before fixing

## Anti-Placeholder Rules (CRITICAL)

**DO NOT** implement placeholder, stub, or minimal implementations. Every fix must be **complete and production-ready**.

- Do NOT leave \`// TODO\`, \`// FIXME\`, or \`throw new Error('not implemented')\` in the code
- Do NOT write empty function bodies or return dummy values
- Do NOT skip edge cases or error handling that the finding describes
- Do NOT assume something is already implemented without verifying — run \`grep\` or read the file first
- If a fix requires changes in multiple files, change ALL of them — partial fixes are worse than no fix
- If you cannot fully resolve a finding, do NOT mark it as \`"passes": true\` — leave it for the next iteration

Violation of these rules wastes iterations and burns tokens for zero progress.

## Adaptive PRD

The \`prd.json\` is a **living document**. You may modify it during your iteration:

### Reprioritize
If you discover that a later story should be fixed first (e.g., it blocks other fixes, or is a root cause), you may reorder priorities by updating the \`"priority"\` field. Always fix the **lowest priority number** story with \`"passes": false\`.

### Add Discovered Stories
If fixing a story reveals a **new issue** not covered by existing stories, you may add it to \`prd.json\`:
\`\`\`json
{
  "id": "FIX-DIS-001",
  "actId": "DISCOVERED",
  "title": "Fix: <description>",
  "description": "<what you found and why it matters>",
  "acceptanceCriteria": [
    "The issue is resolved",
    "\`npm run build\` succeeds",
    "\`npm test\` passes"
  ],
  "priority": 999,
  "passes": false,
  "notes": "Discovered during FIX-NNN iteration"
}
\`\`\`

### Skip a Story
If a story is **impossible to fix** (e.g., the finding is a false positive, or the code was already deleted), set \`"passes": true\` and add a \`"skipped": "reason"\` field. Log the reason in progress.txt.

### Rules
- Never remove existing stories — only add or update
- Log all PRD changes in progress.txt with rationale
- Discovered stories with \`actId: "DISCOVERED"\` will not sync to report checkboxes (this is expected)

## Progress Report Format

APPEND to \`${cleanDir}/progress.txt\` (never replace, always append):

\`\`\`
## [Date/Time] - [FIX-NNN]
- What was fixed
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered
  - Gotchas encountered
  - Useful context
---
\`\`\`

## Consolidate Patterns

If you discover a **reusable pattern**, add it to the \`## Codebase Patterns\` section
at the TOP of \`${cleanDir}/progress.txt\` (create it if it doesn't exist). Only add patterns
that are **general and reusable**, not fix-specific details.

## Verification

\`\`\`bash
npm run build && npm test
\`\`\`

## Completion Signal

When all stories in prd.json have \`"passes": true\`, output exactly:

\`\`\`
<promise>COMPLETE</promise>
\`\`\`
`;
}

/**
 * Registers the `clean` CLI sub-command on the given Commander program.
 *
 * The sub-command generates Ralph remediation artifacts (prd.json, CLAUDE.md,
 * progress.txt) from unchecked axis findings. Accepts a single axis name or
 * `"all"` to aggregate findings across every axis.
 *
 * @param program - The root Commander {@link Command} instance to attach the sub-command to.
 */
export function registerCleanCommand(program: Command): void {
  program
    .command('clean <axis>')
    .description('Generate Ralph artifacts from axis findings (axis name or "all")')
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

      let items: CleanItem[] = [];
      let cleanName: string;

      if (axis === 'all') {
        cleanName = 'all';
        for (const axisId of REPORT_AXIS_IDS) {
          const content = resolveAxisShards(projectRoot, axisId);
          if (content) {
            items.push(...parseUncheckedActions(content));
          }
        }
      } else {
        // Validate axis name
        const reportAxis = axis as ReportAxisId;
        if (!REPORT_AXIS_IDS.includes(reportAxis)) {
          console.error(chalk.red(`Unknown axis: ${axis}`));
          console.error(`Valid axes: ${REPORT_AXIS_IDS.join(', ')}, all`);
          process.exit(1);
        }

        cleanName = axis;
        const content = resolveAxisShards(projectRoot, reportAxis);
        if (!content) {
          console.log(chalk.yellow(`No findings for axis "${axis}" in the latest run.`));
          return;
        }
        items = parseUncheckedActions(content);
      }

      if (items.length === 0) {
        console.log(chalk.yellow('No unchecked actions found.'));
        return;
      }

      const cleanDir = resolve(projectRoot, '.anatoly', 'clean', cleanName);
      mkdirSync(cleanDir, { recursive: true });

      // Generate artifacts
      const prd = generatePrd(cleanName, items);
      writeFileSync(join(cleanDir, 'prd.json'), JSON.stringify(prd, null, 2));

      writeFileSync(join(cleanDir, 'CLAUDE.md'), generateClaudeMd(cleanName, cleanDir, projectRoot));

      // Initialize progress.txt with Codebase Patterns section
      const progressPath = join(cleanDir, 'progress.txt');
      if (!existsSync(progressPath)) {
        writeFileSync(progressPath, `## Codebase Patterns\n\n---\n\n# Ralph Progress Log\nStarted: ${new Date().toISOString()}\n---\n`);
      }

      // Bootstrap project docs from internal docs when documentation axis is involved
      const hasDocAxis = axis === 'all' || axis === 'documentation';
      if (hasDocAxis) {
        const config = loadConfig(projectRoot);
        const docsPath = config.documentation?.docs_path ?? 'docs';
        const projectDocsDir = resolve(projectRoot, docsPath);
        const internalDocsDir = resolve(projectRoot, '.anatoly', 'docs');
        if (!existsSync(projectDocsDir) && existsSync(internalDocsDir)) {
          cpSync(internalDocsDir, projectDocsDir, { recursive: true });
          console.log(chalk.green(`\u2713 Bootstrapped ${docsPath}/ from .anatoly/docs/`));
        }
      }

      console.log(chalk.green(`\u2713 Clean artifacts generated in .anatoly/clean/${cleanName}/`));
      console.log(`  prd.json      \u2014 ${items.length} user stories`);
      console.log(`  CLAUDE.md     \u2014 agent instructions`);
      console.log(`  progress.txt  \u2014 learnings log with Codebase Patterns section`);
      console.log('');
      console.log('To start the clean loop:');
      console.log(chalk.cyan(`  npx anatoly clean-run ${axis}`));
    });
}
