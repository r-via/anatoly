import type { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import chalk from 'chalk';

/**
 * A parsed unchecked action from a shard report.
 */
export interface FixItem {
  actId: string;
  severity: string;
  source: string;
  file: string;
  description: string;
  symbol?: string;
}

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
 */
export function parseUncheckedActions(content: string): FixItem[] {
  const items: FixItem[] = [];

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

function generatePrd(shardName: string, items: FixItem[]): object {
  return {
    project: 'Anatoly Fix',
    branchName: `fix/anatoly-${shardName}`,
    description: `Automated remediation of ${items.length} findings from ${shardName}.md`,
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

function generateClaudeMd(shardFile: string): string {
  return `# Fix Agent Instructions

## Role

You are an autonomous TypeScript correction agent working in a Ralph loop.
Your job is to fix audit findings one at a time, as described in \`prd.json\`.

## Workflow

1. Read \`prd.json\` to find the first user story where \`"passes": false\`
2. Read \`progress.txt\` — check the **Codebase Patterns** section first for learnings from previous iterations
3. Check you're on the correct branch from PRD \`branchName\`. If not, check it out or create from main.
4. Read the corresponding \`.rev.md\` file in the run's reviews/ directory for detailed context
5. Fix the issue in the source code
6. Verify: \`npm run build && npm test\`
7. Commit: \`git commit -m "fix: [FIX-NNN] - short description"\`
8. Update \`prd.json\`: set \`"passes": true\` for the completed story
9. Append your progress to \`progress.txt\` (see format below)
10. If all stories have \`"passes": true\`, output \`<promise>COMPLETE</promise>\`

## Constraints

- Only modify files matching: \`src/**/*.ts\`, \`test/**/*.ts\`, \`*.test.ts\`
- One fix per iteration — do not batch multiple stories
- Always verify \`npm run build && npm test\` before committing
- Read the \`.rev.md\` transcript for full axis-by-axis context before fixing

## Progress Report Format

APPEND to progress.txt (never replace, always append):

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
at the TOP of progress.txt (create it if it doesn't exist). Only add patterns that are
**general and reusable**, not fix-specific details.

## Source Report

The findings come from: \`${shardFile}\`

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

export function registerFixCommand(program: Command): void {
  program
    .command('fix <report-file>')
    .description('Generate Ralph artifacts from a shard report for autonomous fix loop')
    .action((reportFile: string) => {
      const projectRoot = process.cwd();
      const absPath = resolve(projectRoot, reportFile);

      if (!existsSync(absPath)) {
        console.error(chalk.red(`File not found: ${reportFile}`));
        process.exit(1);
      }

      const content = readFileSync(absPath, 'utf-8');
      const items = parseUncheckedActions(content);

      if (items.length === 0) {
        console.log(chalk.yellow('No unchecked actions found in the report file.'));
        return;
      }

      // Derive shard name: report.1.md → report.1
      const shardName = basename(reportFile, '.md');
      const fixDir = resolve(projectRoot, '.anatoly', 'fix', shardName);
      mkdirSync(fixDir, { recursive: true });

      // Generate artifacts
      const prd = generatePrd(shardName, items);
      writeFileSync(join(fixDir, 'prd.json'), JSON.stringify(prd, null, 2));

      writeFileSync(join(fixDir, 'CLAUDE.md'), generateClaudeMd(reportFile));

      // Initialize progress.txt with Codebase Patterns section
      const progressPath = join(fixDir, 'progress.txt');
      if (!existsSync(progressPath)) {
        writeFileSync(progressPath, `## Codebase Patterns\n\n---\n\n# Ralph Progress Log\nStarted: ${new Date().toISOString()}\n---\n`);
      }

      console.log(chalk.green(`\u2713 Fix artifacts generated in .anatoly/fix/${shardName}/`));
      console.log(`  prd.json      \u2014 ${items.length} user stories`);
      console.log(`  CLAUDE.md     \u2014 agent instructions`);
      console.log(`  progress.txt  \u2014 learnings log with Codebase Patterns section`);
      console.log('');
      console.log('To start the fix loop:');
      console.log(chalk.cyan(`  npx anatoly fix-run ${reportFile}`));
    });
}
