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

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Semaphore } from './sdk-semaphore.js';
import { assertSafeOutputPath } from './docs-guard.js';
import type { PagePrompt } from './doc-generator.js';
import { resolveSystemPrompt } from './prompt-resolver.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

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
  const { prompts, outputDir, projectRoot, docsPath, semaphore, executor, onPageComplete, onPageError } = params;

  if (prompts.length === 0) {
    return { pagesWritten: 0, pagesFailed: 0, totalCostUsd: 0, errors: [] };
  }

  const results = await Promise.allSettled(
    prompts.map(prompt => executeOnePage(prompt, outputDir, projectRoot, docsPath ?? 'docs', semaphore, executor, onPageComplete, onPageError)),
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

async function executeOnePage(
  prompt: DocPrompt,
  outputDir: string,
  projectRoot: string,
  docsPath: string,
  semaphore: Semaphore,
  executor: DocExecutor,
  onPageComplete?: (pagePath: string) => void,
  onPageError?: (pagePath: string, error: Error) => void,
): Promise<{ costUsd: number }> {
  await semaphore.acquire();
  try {
    const result = await executor({
      system: prompt.system,
      user: prompt.user,
      model: prompt.model,
    });

    // Ensure subdirectory exists and guard against docs/ writes
    const fullPath = join(outputDir, prompt.pagePath);
    assertSafeOutputPath(fullPath, projectRoot, docsPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, result.text, 'utf-8');

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
 * Deterministic structure linter for .anatoly/docs/.
 * No LLM call — all checks are regex/filesystem-based.
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
    for (let i = 0; i < numbered.length; i++) {
      const expected = i + 1;
      if (numbered[i].num !== expected) {
        issues.push({ path: `${dir}/${numbered[i].file}`, rule: 'numbering-gap', detail: `numbered ${String(numbered[i].num).padStart(2, '0')} but expected ${String(expected).padStart(2, '0')}`, fixed: false });
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

// --- Coherence review agent (Opus multi-turn) ---

export interface DocCoherenceReviewResult {
  loopsCompleted: number;
  linterIssuesBefore: number;
  linterIssuesAfter: number;
  costUsd: number;
  durationMs: number;
}

export interface DocCoherenceReviewParams {
  outputDir: string;
  projectRoot: string;
  docsPath: string;
  maxLoops?: number;
  abortController?: AbortController;
  logDir?: string;
  callbacks?: {
    onLoopStart?: (loop: number) => void;
    onLoopEnd?: (loop: number, linterIssues: number) => void;
  };
}

/**
 * Multi-turn Opus agent that reads all doc pages, identifies cross-page
 * coherence issues, and fixes them using Read/Write tools.
 * Runs up to maxLoops audit-fix-verify cycles with the deterministic
 * linter as verification after each loop.
 */
export async function runDocCoherenceReview(params: DocCoherenceReviewParams): Promise<DocCoherenceReviewResult> {
  const {
    outputDir,
    projectRoot,
    docsPath,
    maxLoops = 3,
    abortController,
    logDir,
    callbacks,
  } = params;

  const start = Date.now();
  let totalCostUsd = 0;
  const conversationLog: string[] = [];

  // Build system prompt
  const systemPrompt = resolveSystemPrompt('doc-generation.coherence-review');

  // Build file listing for the user message
  const files = collectMarkdownFiles(outputDir);
  const fileListing = files.map(f => `  - ${relative(outputDir, f.fullPath)}`).join('\n');

  // Initial linter run to know the baseline
  const baselineLint = reviewDocStructure(outputDir, projectRoot, docsPath);
  const linterIssuesBefore = baselineLint.issues.filter(i => !i.fixed).length;

  let linterIssuesAfter = linterIssuesBefore;
  let loopsCompleted = 0;

  for (let loop = 1; loop <= maxLoops; loop++) {
    callbacks?.onLoopStart?.(loop);

    // Build user message — first loop gets full instructions, subsequent loops get linter feedback
    let userMessage: string;
    if (loop === 1) {
      userMessage = [
        `The documentation directory is your current working directory.`,
        ``,
        `## Files in this documentation site (${files.length} total)`,
        fileListing,
        ``,
        `Please read all pages, identify coherence issues, and fix them.`,
      ].join('\n');
    } else {
      const currentLint = reviewDocStructure(outputDir, projectRoot, docsPath);
      const unfixed = currentLint.issues.filter(i => !i.fixed);
      userMessage = [
        `The linter still found ${unfixed.length} issues after your last pass:`,
        '',
        ...unfixed.map(i => `- **${i.path}**: [${i.rule}] ${i.detail}`),
        '',
        'Please fix these remaining issues.',
      ].join('\n');
    }

    conversationLog.push(`\n# Loop ${loop}\n\n## User\n\n${userMessage}\n`);

    // Run the Opus agent
    const ac = abortController ?? new AbortController();
    const q = query({
      prompt: userMessage,
      options: {
        systemPrompt,
        model: 'opus',
        cwd: outputDir,
        allowedTools: ['Read', 'Write'],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        maxTurns: 50,
        abortController: ac,
      },
    });

    let resultText = '';
    for await (const message of q) {
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          resultText = (message as { result: string }).result;
          totalCostUsd += (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
        } else {
          const errMsg = (message as { errors?: string[] }).errors?.join(', ') ?? message.subtype;
          conversationLog.push(`\n## Error\n\n${errMsg}\n`);
          break;
        }
      }
    }

    conversationLog.push(`\n## Assistant\n\n${resultText}\n`);

    // Verify with deterministic linter
    const verifyLint = reviewDocStructure(outputDir, projectRoot, docsPath);
    linterIssuesAfter = verifyLint.issues.filter(i => !i.fixed).length;
    loopsCompleted = loop;

    callbacks?.onLoopEnd?.(loop, linterIssuesAfter);

    // Early exit if clean
    if (linterIssuesAfter === 0) break;
  }

  // Write conversation log
  if (logDir) {
    mkdirSync(logDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const durationMs = Date.now() - start;

    const header = [
      `# Coherence Review — ${timestamp}`,
      '',
      `- **Loops:** ${loopsCompleted}/${maxLoops}`,
      `- **Duration:** ${(durationMs / 1000).toFixed(1)}s`,
      `- **Cost:** $${totalCostUsd.toFixed(4)}`,
      `- **Linter issues before:** ${linterIssuesBefore}`,
      `- **Linter issues after:** ${linterIssuesAfter}`,
      '',
    ].join('\n');

    writeFileSync(join(logDir, 'coherence-review.md'), header + conversationLog.join('\n'), 'utf-8');
  }

  return {
    loopsCompleted,
    linterIssuesBefore,
    linterIssuesAfter,
    costUsd: totalCostUsd,
    durationMs: Date.now() - start,
  };
}
