// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Doc LLM Executor — Story 29.17
 *
 * Executes PagePrompt[] via the SDK and writes generated content to disk.
 * Uses the global semaphore for concurrency control and Promise.allSettled
 * for resilience (one page failure doesn't block others).
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { countTokens } from './estimator.js';
import { getDocTokenBudget } from './docs-resolver.js';
import type { Semaphore } from './sdk-semaphore.js';
import { assertSafeOutputPath } from './docs-guard.js';
import type { PagePrompt } from './doc-generator.js';
import { resolveSystemPrompt } from './prompt-resolver.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { retryWithBackoff } from '../utils/rate-limiter.js';
import { contextLogger } from '../utils/log-context.js';

// --- Public interfaces ---

/** @deprecated Use PagePrompt from doc-generator.ts instead */
export type DocPrompt = PagePrompt;

export interface ExecutorResult {
  text: string;
  costUsd: number;
}

export type DocExecutor = (prompt: { system: string; user: string; model: string }) => Promise<ExecutorResult>;

export interface ExecuteDocPromptsParams {
  prompts: DocPrompt[];
  outputDir: string;
  projectRoot: string;
  docsPath?: string;
  semaphore: Semaphore;
  executor: DocExecutor;
  onPageStart?: (pagePath: string) => void;
  onPageComplete?: (pagePath: string) => void;
  onPageError?: (pagePath: string, error: Error) => void;
}

export interface DocLlmResult {
  pagesWritten: number;
  pagesFailed: number;
  totalCostUsd: number;
  errors: Array<{ pagePath: string; error: string }>;
}

// --- Main entry point ---

/**
 * Executes doc generation prompts via the SDK with semaphore-bounded
 * concurrency. Writes LLM output to the corresponding file in outputDir.
 *
 * Uses Promise.allSettled so a single page failure doesn't block others.
 */
export async function executeDocPrompts(params: ExecuteDocPromptsParams): Promise<DocLlmResult> {
  const { prompts, outputDir, projectRoot, docsPath, semaphore, executor, onPageStart, onPageComplete, onPageError } = params;

  if (prompts.length === 0) {
    return { pagesWritten: 0, pagesFailed: 0, totalCostUsd: 0, errors: [] };
  }

  const results = await Promise.allSettled(
    prompts.map(prompt => executeOnePage(prompt, outputDir, projectRoot, docsPath ?? 'docs', semaphore, executor, onPageStart, onPageComplete, onPageError)),
  );

  let pagesWritten = 0;
  let pagesFailed = 0;
  let totalCostUsd = 0;
  const errors: Array<{ pagePath: string; error: string }> = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      pagesWritten++;
      totalCostUsd += result.value.costUsd;
    } else {
      pagesFailed++;
      errors.push({
        pagePath: prompts[i].pagePath,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  return { pagesWritten, pagesFailed, totalCostUsd, errors };
}

// --- Internal ---

/**
 * Execute a single doc-generation prompt through the executor, writing the
 * result to disk. Acquires a semaphore slot for the duration of the call
 * and releases it in a finally block to guarantee no leaks.
 *
 * Retry logic lives in the executor itself (via {@link retryWithBackoff}),
 * not here — this keeps the semaphore scope tight.
 */
async function executeOnePage(
  prompt: DocPrompt,
  outputDir: string,
  projectRoot: string,
  docsPath: string,
  semaphore: Semaphore,
  executor: DocExecutor,
  onPageStart?: (pagePath: string) => void,
  onPageComplete?: (pagePath: string) => void,
  onPageError?: (pagePath: string, error: Error) => void,
): Promise<{ costUsd: number }> {
  await semaphore.acquire();
  try {
    onPageStart?.(prompt.pagePath);
    const result = await executor({
      system: prompt.system,
      user: prompt.user,
      model: prompt.model,
    });

    // Strip any preamble before the first markdown heading
    let content = result.text;
    const headingIdx = content.search(/^# /m);
    if (headingIdx > 0) {
      content = content.slice(headingIdx);
    }

    // Ensure subdirectory exists and guard against docs/ writes
    const fullPath = join(outputDir, prompt.pagePath);
    assertSafeOutputPath(fullPath, projectRoot, docsPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');

    onPageComplete?.(prompt.pagePath);
    return { costUsd: result.costUsd };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    onPageError?.(prompt.pagePath, error);
    throw error;
  } finally {
    semaphore.release();
  }
}

// --- Structure review pass (deterministic) ---

export interface DocStructureReviewResult {
  filesScanned: number;
  filesFixed: number;
  fixedPaths: string[];
  issues: StructureIssue[];
  costUsd: number;
}

export interface StructureIssue {
  path: string;
  rule: string;
  detail: string;
  fixed: boolean;
}

export interface DocStructureReviewCallbacks {
  onCollected?: (fileCount: number, totalSizeKb: number) => void;
  onCheck?: (rule: string, issueCount: number) => void;
  onFileFixed?: (path: string, rule: string) => void;
}

export interface DocStructureReviewOptions {
  callbacks?: DocStructureReviewCallbacks;
  logDir?: string;
}

/**
 * Deterministic structure linter for `.anatoly/docs/`.
 * No LLM call — all checks are regex/filesystem-based.
 *
 * Runs seven checks in order:
 * 1. **preamble** — strips text before the first `# ` heading (auto-fixed).
 * 2. **wrapping-fence** — removes wrapping ````markdown` fences (auto-fixed).
 * 3. **heading-hierarchy** — verifies exactly one h1 and no skipped levels.
 * 4. **numbering-gap** — detects file numbering gaps and mixed numbered/unnumbered files.
 * 5. **index completeness** — flags pages missing from `index.md` and orphan links.
 * 6. **broken-link** — resolves internal `.md` links and reports dead references.
 * 7. **index-order** — checks that `## N.` section headings appear in ascending order.
 *
 * Auto-fixable issues (preamble, wrapping-fence) are written back to disk
 * within the `outputDir` boundary. A summary log is written to `logDir`
 * when provided.
 *
 * @param outputDir - Root directory containing the generated doc pages.
 * @param projectRoot - Absolute path to the project root (used for path safety).
 * @param docsPath - Relative path to the user-facing docs directory (guarded from writes).
 * @param _executor - Unused; kept for API compatibility.
 * @param optionsOrCallbacks - Either a `DocStructureReviewOptions` object or
 *   a bare `DocStructureReviewCallbacks` object (legacy overload, auto-wrapped).
 * @returns A {@link DocStructureReviewResult} with scan counts, auto-fixed paths,
 *   the full issue list, and a zero `costUsd` (no LLM involved).
 */
export function reviewDocStructure(
  outputDir: string,
  projectRoot: string,
  docsPath: string,
  _executor?: DocExecutor, // kept for API compat, unused
  optionsOrCallbacks?: DocStructureReviewOptions | DocStructureReviewCallbacks,
): DocStructureReviewResult {
  const opts: DocStructureReviewOptions =
    optionsOrCallbacks && ('onCollected' in optionsOrCallbacks || 'onCheck' in optionsOrCallbacks || 'onFileFixed' in optionsOrCallbacks)
      ? { callbacks: optionsOrCallbacks as DocStructureReviewCallbacks }
      : (optionsOrCallbacks as DocStructureReviewOptions) ?? {};
  const { callbacks, logDir } = opts;

  const files = collectMarkdownFiles(outputDir);
  if (files.length === 0) return { filesScanned: 0, filesFixed: 0, fixedPaths: [], issues: [], costUsd: 0 };

  const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);
  callbacks?.onCollected?.(files.length, Math.round(totalSize / 1024));

  const fileMap = new Map<string, { fullPath: string; content: string }>();
  for (const f of files) {
    fileMap.set(relative(outputDir, f.fullPath), f);
  }
  const allPaths = new Set(fileMap.keys());

  const issues: StructureIssue[] = [];
  const modified = new Map<string, string>(); // relPath → new content

  // --- Check 1: LLM preamble ---
  for (const [relPath, file] of fileMap) {
    const headingIdx = file.content.search(/^# /m);
    if (headingIdx > 0) {
      const preamble = file.content.slice(0, headingIdx).trim();
      if (preamble.length > 0) {
        const fixed = file.content.slice(headingIdx);
        modified.set(relPath, fixed);
        issues.push({ path: relPath, rule: 'preamble', detail: `removed ${preamble.length} chars before heading`, fixed: true });
      }
    }
  }
  callbacks?.onCheck?.('preamble', issues.filter(i => i.rule === 'preamble').length);

  // --- Check 2: Wrapping markdown fences ---
  const fenceBefore = issues.length;
  for (const [relPath, file] of fileMap) {
    const content = modified.get(relPath) ?? file.content;
    const fenceRe = /^```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/;
    const match = content.match(fenceRe);
    if (match) {
      modified.set(relPath, match[1]);
      issues.push({ path: relPath, rule: 'wrapping-fence', detail: 'removed wrapping ```markdown fence', fixed: true });
    }
  }
  callbacks?.onCheck?.('wrapping-fence', issues.length - fenceBefore);

  // --- Check 3: Heading hierarchy (exactly one h1, no skipped levels) ---
  const headingBefore = issues.length;
  for (const [relPath, file] of fileMap) {
    const content = modified.get(relPath) ?? file.content;
    // Strip fenced code blocks so that shell comments (# ...) are not counted as headings
    const stripped = content.replace(/^```[\s\S]*?^```/gm, '');
    const headings = [...stripped.matchAll(/^(#{1,6}) /gm)].map(m => m[1].length);
    const h1Count = headings.filter(h => h === 1).length;
    if (h1Count === 0) {
      issues.push({ path: relPath, rule: 'heading-hierarchy', detail: 'missing h1 heading', fixed: false });
    } else if (h1Count > 1) {
      issues.push({ path: relPath, rule: 'heading-hierarchy', detail: `${h1Count} h1 headings (expected 1)`, fixed: false });
    }
  }
  callbacks?.onCheck?.('heading-hierarchy', issues.length - headingBefore);

  // --- Check 4: File numbering gaps within directories ---
  const numberBefore = issues.length;
  const dirs = new Map<string, string[]>();
  for (const relPath of allPaths) {
    if (relPath === 'index.md' || relPath === '.cache.json') continue;
    const parts = relPath.split('/');
    if (parts.length === 2) {
      const dir = parts[0];
      const existing = dirs.get(dir) ?? [];
      existing.push(parts[1]);
      dirs.set(dir, existing);
    }
  }
  for (const [dir, filesInDir] of dirs) {
    const numbered = filesInDir
      .map(f => ({ file: f, num: parseInt(f.match(/^(\d+)-/)?.[1] ?? '', 10) }))
      .filter(f => !isNaN(f.num))
      .sort((a, b) => a.num - b.num);
    const unnumbered = filesInDir.filter(f => !/^\d+-/.test(f));

    // Check numbering gaps
    for (let i = 0; i < numbered.length; i++) {
      const expected = i + 1;
      if (numbered[i].num !== expected) {
        issues.push({ path: `${dir}/${numbered[i].file}`, rule: 'numbering-gap', detail: `numbered ${String(numbered[i].num).padStart(2, '0')} but expected ${String(expected).padStart(2, '0')}`, fixed: false });
      }
    }

    // Check mixed numbering: if some files are numbered, all should be
    if (numbered.length > 0 && unnumbered.length > 0) {
      for (const file of unnumbered) {
        issues.push({ path: `${dir}/${file}`, rule: 'numbering-gap', detail: `unnumbered file in directory with numbered files — should be numbered`, fixed: false });
      }
    }
  }
  callbacks?.onCheck?.('numbering-gap', issues.length - numberBefore);

  // --- Check 5: Index completeness and orphans ---
  const indexBefore = issues.length;
  const indexFile = fileMap.get('index.md');
  if (indexFile) {
    const indexContent = modified.get('index.md') ?? indexFile.content;
    const linkedPaths = new Set([...indexContent.matchAll(/\[.*?\]\((.*?\.md)\)/g)].map(m => m[1]));
    // Missing from index
    for (const relPath of allPaths) {
      if (relPath === 'index.md' || relPath === '.cache.json') continue;
      if (!linkedPaths.has(relPath)) {
        issues.push({ path: 'index.md', rule: 'index-missing', detail: `${relPath} not linked in index`, fixed: false });
      }
    }
    // Orphan links in index
    for (const linked of linkedPaths) {
      if (!allPaths.has(linked)) {
        issues.push({ path: 'index.md', rule: 'index-orphan', detail: `links to ${linked} which does not exist`, fixed: false });
      }
    }
  }
  callbacks?.onCheck?.('index', issues.length - indexBefore);

  // --- Check 6: Broken internal links ---
  const linksBefore = issues.length;
  for (const [relPath, file] of fileMap) {
    const content = modified.get(relPath) ?? file.content;
    const dir = relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : '';
    const links = [...content.matchAll(/\[.*?\]\((\.\.?\/.*?\.md|[a-zA-Z].*?\.md)\)/g)];
    for (const link of links) {
      const target = link[1];
      // Resolve relative path
      const resolved = dir ? join(dir, target).split('\\').join('/') : target;
      const normalized = resolved.replace(/^\.\//, '');
      if (!allPaths.has(normalized)) {
        issues.push({ path: relPath, rule: 'broken-link', detail: `links to ${target} (resolved: ${normalized}) — file not found`, fixed: false });
      }
    }
  }
  callbacks?.onCheck?.('broken-link', issues.length - linksBefore);

  // --- Check 7: Index section ordering ---
  const orderBefore = issues.length;
  if (indexFile) {
    const indexContent = modified.get('index.md') ?? indexFile.content;
    const sectionNumbers = [...indexContent.matchAll(/^## (\d+)\./gm)].map(m => parseInt(m[1], 10));
    for (let i = 1; i < sectionNumbers.length; i++) {
      if (sectionNumbers[i] < sectionNumbers[i - 1]) {
        issues.push({ path: 'index.md', rule: 'index-order', detail: `section ${sectionNumbers[i]} appears after section ${sectionNumbers[i - 1]}`, fixed: false });
      }
    }
  }
  callbacks?.onCheck?.('index-order', issues.length - orderBefore);

  // Apply auto-fixable changes
  const fixedPaths: string[] = [];
  const resolvedOutputDir = resolve(outputDir);
  for (const [relPath, newContent] of modified) {
    const fullPath = join(outputDir, relPath);
    const resolvedFull = resolve(fullPath);
    if (!resolvedFull.startsWith(resolvedOutputDir + sep) && resolvedFull !== resolvedOutputDir) continue;
    assertSafeOutputPath(fullPath, projectRoot, docsPath);
    writeFileSync(fullPath, newContent, 'utf-8');
    fixedPaths.push(relPath);
    for (const issue of issues.filter(i => i.path === relPath && i.fixed)) {
      callbacks?.onFileFixed?.(relPath, issue.rule);
    }
  }

  const reviewResult: DocStructureReviewResult = {
    filesScanned: files.length,
    filesFixed: fixedPaths.length,
    fixedPaths,
    issues,
    costUsd: 0,
  };

  // Write log
  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const summaryLines: string[] = [
      `# Structure Review — ${timestamp}`,
      '',
      `- **Files scanned:** ${files.length}`,
      `- **Issues found:** ${issues.length}`,
      `- **Auto-fixed:** ${fixedPaths.length} files`,
      '',
    ];
    if (issues.length > 0) {
      summaryLines.push('## Issues', '');
      summaryLines.push('| File | Rule | Detail | Fixed |');
      summaryLines.push('|------|------|--------|-------|');
      for (const issue of issues) {
        summaryLines.push(`| \`${issue.path}\` | ${issue.rule} | ${issue.detail} | ${issue.fixed ? 'yes' : 'no'} |`);
      }
    } else {
      summaryLines.push('No structural issues found.');
    }
    writeFileSync(join(logDir, 'summary.md'), summaryLines.join('\n'), 'utf-8');
  }

  return reviewResult;
}

// --- Auto-fix structural issues (deterministic) ---

export interface AutoFixResult {
  renames: Array<{ from: string; to: string }>;
  indexEntriesAdded: string[];
  indexOrphansRemoved: string[];
  linksUpdated: number;
}

/**
 * Deterministic auto-fix for structural issues that the linter detects but
 * cannot fix today: numbering-gap (unnumbered files), index-missing, and
 * index-orphan. Runs AFTER {@link reviewDocStructure} and mutates files on disk.
 *
 * Returns a summary of what was changed so the caller can decide whether
 * to skip the expensive coherence review.
 */
export function autoFixStructuralIssues(
  outputDir: string,
  issues: StructureIssue[],
): AutoFixResult {
  const result: AutoFixResult = { renames: [], indexEntriesAdded: [], indexOrphansRemoved: [], linksUpdated: 0 };

  // --- 1. Fix unnumbered files (numbering-gap with "unnumbered" detail) ---
  const unnumberedIssues = issues.filter(i => i.rule === 'numbering-gap' && i.detail.includes('unnumbered'));
  if (unnumberedIssues.length > 0) {
    // Group by directory
    const byDir = new Map<string, string[]>();
    for (const issue of unnumberedIssues) {
      const parts = issue.path.split('/');
      if (parts.length !== 2) continue;
      const dir = parts[0];
      const existing = byDir.get(dir) ?? [];
      existing.push(parts[1]);
      byDir.set(dir, existing);
    }

    for (const [dir, unnumberedFiles] of byDir) {
      // Find max existing number in this directory
      const dirPath = join(outputDir, dir);
      let entries: string[];
      try { entries = readdirSync(dirPath); } catch { continue; }
      const maxNum = entries
        .map(f => parseInt(f.match(/^(\d+)-/)?.[1] ?? '', 10))
        .filter(n => !isNaN(n))
        .reduce((max, n) => Math.max(max, n), 0);

      let nextNum = maxNum + 1;
      for (const file of unnumberedFiles.sort()) {
        const prefix = String(nextNum).padStart(2, '0');
        const newName = `${prefix}-${file}`;
        const oldRel = `${dir}/${file}`;
        const newRel = `${dir}/${newName}`;

        try {
          renameSync(join(outputDir, oldRel), join(outputDir, newRel));
          result.renames.push({ from: oldRel, to: newRel });
          nextNum++;
        } catch { /* skip if rename fails */ }
      }
    }

    // Update all links across all files to reflect renames
    if (result.renames.length > 0) {
      const allFiles = collectMarkdownFiles(outputDir);
      for (const file of allFiles) {
        let content = file.content;
        let changed = false;
        for (const { from, to } of result.renames) {
          const oldName = from.split('/').pop()!;
          const newName = to.split('/').pop()!;
          // Match markdown links containing the old filename
          const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`(\\]\\([^)]*?)${escaped}(\\))`, 'g');
          const replaced = content.replace(re, (_match, before, after) => {
            changed = true;
            result.linksUpdated++;
            return `${before}${newName}${after}`;
          });
          content = replaced;
        }
        if (changed) {
          writeFileSync(file.fullPath, content, 'utf-8');
        }
      }
    }
  }

  // --- 2. Fix index-missing (add entries to index.md) ---
  const missingIssues = issues.filter(i => i.rule === 'index-missing');
  const indexPath = join(outputDir, 'index.md');
  if (missingIssues.length > 0) {
    let indexContent: string;
    try { indexContent = readFileSync(indexPath, 'utf-8'); } catch { indexContent = ''; }

    for (const issue of missingIssues) {
      // Extract the file path from the detail: "05-Modules/cli.md not linked in index"
      const filePath = issue.detail.split(' ')[0];
      // Apply renames if the file was just renamed
      const renamed = result.renames.find(r => r.from === filePath);
      const actualPath = renamed ? renamed.to : filePath;

      // Build a display name from the filename
      const fileName = actualPath.split('/').pop()!.replace(/\.md$/, '').replace(/^\d+-/, '');
      const entry = `- [${fileName}](${actualPath})`;

      // Find the section for this directory and append
      const dir = actualPath.split('/')[0];
      const sectionRe = new RegExp(`^(## .*${dir.replace(/^\d+-/, '')}.*\n)`, 'im');
      const sectionMatch = indexContent.match(sectionRe);
      if (sectionMatch && sectionMatch.index !== undefined) {
        // Find the end of the link list under this section
        const afterSection = indexContent.slice(sectionMatch.index + sectionMatch[0].length);
        const nextSectionIdx = afterSection.search(/^## /m);
        const insertPos = nextSectionIdx === -1
          ? indexContent.length
          : sectionMatch.index + sectionMatch[0].length + nextSectionIdx;
        // Insert before the next section (with trailing newline)
        indexContent = indexContent.slice(0, insertPos).trimEnd() + '\n' + entry + '\n\n' + indexContent.slice(insertPos).trimStart();
      } else {
        // Fallback: append at end
        indexContent = indexContent.trimEnd() + '\n' + entry + '\n';
      }
      result.indexEntriesAdded.push(actualPath);
    }

    writeFileSync(indexPath, indexContent, 'utf-8');
  }

  // --- 3. Fix index-orphan (remove dead links from index.md) ---
  const orphanIssues = issues.filter(i => i.rule === 'index-orphan');
  if (orphanIssues.length > 0) {
    let indexContent: string;
    try { indexContent = readFileSync(indexPath, 'utf-8'); } catch { return result; }

    for (const issue of orphanIssues) {
      // Extract target path: "links to 05-Modules/old.md which does not exist"
      const match = issue.detail.match(/links to (\S+)/);
      if (!match) continue;
      const deadPath = match[1];
      // Remove the markdown link line containing this path
      const lineRe = new RegExp(`^.*\\]\\(${deadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\).*\n?`, 'gm');
      indexContent = indexContent.replace(lineRe, '');
      result.indexOrphansRemoved.push(deadPath);
    }

    writeFileSync(indexPath, indexContent, 'utf-8');
  }

  return result;
}

function collectMarkdownFiles(dir: string): Array<{ fullPath: string; content: string }> {
  const results: Array<{ fullPath: string; content: string }> = [];

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        results.push({ fullPath: full, content: readFileSync(full, 'utf-8') });
      }
    }
  }

  walk(dir);
  return results.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

// --- Coherence review agent (single-pass, content-injected) ---

export interface DocCoherenceReviewResult {
  linterIssuesBefore: number;
  linterIssuesAfter: number;
  contentInjected: boolean;
  costUsd: number;
  durationMs: number;
}

export interface DocCoherenceReviewParams {
  outputDir: string;
  projectRoot: string;
  docsPath: string;
  abortController?: AbortController;
  logDir?: string;
  semaphore?: Semaphore;
  callbacks?: {
    onToolUse?: (tool: string, filePath: string) => void;
  };
}

/**
 * Single-pass Sonnet agent that reviews all doc pages for cross-page
 * coherence issues and fixes them using Write tools.
 *
 * File contents are injected directly into the prompt when they fit within
 * the 20% context budget (see {@link DOC_BUDGET_RATIO}), eliminating the
 * need for Read tool calls. When the budget is exceeded, the agent falls
 * back to Read + Write with a file listing only.
 *
 * The system prompt instructs the agent to self-verify before finishing,
 * removing the need for external retry loops.
 */
export async function runDocCoherenceReview(params: DocCoherenceReviewParams): Promise<DocCoherenceReviewResult> {
  const {
    outputDir,
    projectRoot,
    docsPath,
    abortController,
    logDir,
    semaphore,
    callbacks,
  } = params;

  const start = Date.now();

  // Build system prompt
  const systemPrompt = resolveSystemPrompt('doc-generation.coherence-review');

  // Collect files and measure token budget
  const files = collectMarkdownFiles(outputDir);
  const tokenBudget = getDocTokenBudget('claude-sonnet-4-6');
  const allContent = files.map(f => {
    const relPath = relative(outputDir, f.fullPath);
    return `<file path="${relPath}">\n${f.content}\n</file>`;
  }).join('\n\n');
  const contentTokens = countTokens(allContent);
  const contentInjected = contentTokens <= tokenBudget;

  // Initial linter run to know the baseline
  const baselineLint = reviewDocStructure(outputDir, projectRoot, docsPath);
  const linterIssuesBefore = baselineLint.issues.filter(i => !i.fixed).length;

  // Build user message
  const parts: string[] = [];

  if (contentInjected) {
    parts.push(
      `Below are all ${files.length} documentation files with their full content.`,
      `Fix any structural coherence issues using the Write tool.`,
      ``,
      allContent,
    );
  } else {
    const fileListing = files.map(f => `  - ${relative(outputDir, f.fullPath)}`).join('\n');
    parts.push(
      `The documentation directory is your current working directory.`,
      ``,
      `## Files in this documentation site (${files.length} total)`,
      fileListing,
      ``,
      `Please read all pages, identify coherence issues, and fix them.`,
    );
  }

  // Include linter issues as starting context
  const unfixed = baselineLint.issues.filter(i => !i.fixed);
  if (unfixed.length > 0) {
    parts.push(``, `## Known structural issues (from linter)`, ``);
    for (const i of unfixed) {
      parts.push(`- **${i.path}**: [${i.rule}] ${i.detail}`);
    }
  }

  const userMessage = parts.join('\n');

  // Determine allowed tools based on whether content was injected
  const allowedTools = contentInjected ? ['Write'] : ['Read', 'Write'];

  // Run the Sonnet agent — single pass (acquire semaphore slot so UI shows 1/N active)
  if (semaphore) await semaphore.acquire();
  const ac = abortController ?? new AbortController();
  let resultText = '';
  let costUsd = 0;
  try {
    const result = await retryWithBackoff(
      async () => {
        const q = query({
          prompt: userMessage,
          options: {
            systemPrompt,
            model: 'sonnet',
            cwd: outputDir,
            allowedTools,
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
            maxTurns: 60,
            abortController: ac,
          },
        });

        let text = '';
        let cost = 0;
        for await (const message of q) {
          if (message.type === 'result') {
            if (message.subtype === 'success') {
              text = (message as { result: string }).result;
              cost = (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
            } else {
              const errMsg = (message as { errors?: string[] }).errors?.join(', ') ?? message.subtype;
              throw new Error(`SDK error [${message.subtype}]: ${errMsg}`);
            }
          }
          // Track tool use for UI display
          if (message.type === 'assistant' && callbacks?.onToolUse) {
            const msg = message as { content?: Array<{ type: string; name?: string; input?: { file_path?: string } }> };
            for (const block of msg.content ?? []) {
              if (block.type === 'tool_use' && block.name && block.input?.file_path) {
                callbacks.onToolUse(block.name, block.input.file_path);
              }
            }
          }
        }
        return { text, cost };
      },
      {
        maxRetries: 3,
        baseDelayMs: 5_000,
        maxDelayMs: 60_000,
        jitterFactor: 0.2,
        filePath: 'coherence-review',
        onRetry: (attempt, delayMs) => {
          contextLogger().warn({ attempt, delayMs }, 'coherence review retrying');
        },
      },
    );
    resultText = result.text;
    costUsd = result.cost;
  } finally {
    if (semaphore) semaphore.release();
  }

  // Post-review linter verification
  const verifyLint = reviewDocStructure(outputDir, projectRoot, docsPath);
  const linterIssuesAfter = verifyLint.issues.filter(i => !i.fixed).length;

  // Write conversation log
  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const durationMs = Date.now() - start;

    const header = [
      `# Coherence Review — ${timestamp}`,
      '',
      `- **Model:** sonnet (single pass)`,
      `- **Content injected:** ${contentInjected} (${contentTokens} tokens, budget ${tokenBudget})`,
      `- **Tools:** ${allowedTools.join(', ')}`,
      `- **Duration:** ${(durationMs / 1000).toFixed(1)}s`,
      `- **Cost:** $${costUsd.toFixed(4)}`,
      `- **Linter issues before:** ${linterIssuesBefore}`,
      `- **Linter issues after:** ${linterIssuesAfter}`,
      '',
      '## User',
      '',
      contentInjected ? `[${files.length} files injected — ${contentTokens} tokens]` : userMessage,
      '',
      '## Assistant',
      '',
      resultText,
    ].join('\n');

    writeFileSync(join(logDir, 'coherence-review.md'), header, 'utf-8');
  }

  return {
    linterIssuesBefore,
    linterIssuesAfter,
    contentInjected,
    costUsd,
    durationMs: Date.now() - start,
  };
}

// --- Content review agent (Opus, gap-report-driven) ---

export interface DocContentReviewResult {
  costUsd: number;
  durationMs: number;
}

export interface DocContentReviewParams {
  outputDir: string;
  projectRoot: string;
  /** The gap report formatted as text, injected into the user message. */
  gapReportText: string;
  abortController?: AbortController;
  logDir?: string;
  semaphore?: Semaphore;
  callbacks?: {
    onStart?: () => void;
    onDone?: () => void;
    onToolUse?: (tool: string, filePath: string) => void;
  };
}

/**
 * Opus agent that receives the gap analysis report and updates doc pages
 * to fill content gaps. Focused on content only — not structure.
 */
export async function runDocContentReview(params: DocContentReviewParams): Promise<DocContentReviewResult> {
  const { outputDir, gapReportText, abortController, logDir, semaphore, callbacks } = params;

  const start = Date.now();
  callbacks?.onStart?.();

  const systemPrompt = resolveSystemPrompt('doc-generation.content-review');
  const userMessage = [
    'Your current working directory contains the documentation files.',
    '',
    '## Gap Analysis Report',
    '',
    gapReportText,
    '',
    'Please read the pages listed above and add the missing content.',
  ].join('\n');

  const ac = abortController ?? new AbortController();
  let resultText = '';
  let costUsd = 0;
  if (semaphore) await semaphore.acquire();
  try {
    const result = await retryWithBackoff(
      async () => {
        const q = query({
          prompt: userMessage,
          options: {
            systemPrompt,
            model: 'opus',
            cwd: outputDir,
            allowedTools: ['Read', 'Write'],
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
            maxTurns: 200,
            abortController: ac,
          },
        });

        let text = '';
        let cost = 0;
        for await (const message of q) {
          if (message.type === 'result') {
            if (message.subtype === 'success') {
              text = (message as { result: string }).result;
              cost = (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
            } else {
              const errMsg = (message as { errors?: string[] }).errors?.join(', ') ?? message.subtype;
              throw new Error(`SDK error [${message.subtype}]: ${errMsg}`);
            }
          }
          if (message.type === 'assistant' && callbacks?.onToolUse) {
            const msg = message as { content?: Array<{ type: string; name?: string; input?: { file_path?: string } }> };
            for (const block of msg.content ?? []) {
              if (block.type === 'tool_use' && block.name && block.input?.file_path) {
                callbacks.onToolUse(block.name, block.input.file_path);
              }
            }
          }
        }
        return { text, cost };
      },
      {
        maxRetries: 3,
        baseDelayMs: 5_000,
        maxDelayMs: 60_000,
        jitterFactor: 0.2,
        filePath: 'content-review',
        onRetry: (attempt, delayMs) => {
          contextLogger().warn({ attempt, delayMs }, 'content review retrying');
        },
      },
    );
    resultText = result.text;
    costUsd = result.cost;
  } finally {
    if (semaphore) semaphore.release();
  }

  callbacks?.onDone?.();

  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const logContent = [
      `# Content Review — ${timestamp}`,
      '',
      `- **Duration:** ${((Date.now() - start) / 1000).toFixed(1)}s`,
      `- **Cost:** $${costUsd.toFixed(4)}`,
      '',
      '## System',
      '', systemPrompt, '',
      '## User',
      '', userMessage, '',
      '## Assistant',
      '', resultText,
    ].join('\n');
    writeFileSync(join(logDir, 'content-review.md'), logContent, 'utf-8');
  }

  return { costUsd, durationMs: Date.now() - start };
}
