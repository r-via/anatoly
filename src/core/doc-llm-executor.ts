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
import { extractJson } from '../utils/extract-json.js';

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

// --- Structure review pass ---

export interface DocStructureReviewResult {
  filesScanned: number;
  filesFixed: number;
  fixedPaths: string[];
  costUsd: number;
}

export interface DocStructureReviewCallbacks {
  onCollected?: (fileCount: number, totalSizeKb: number) => void;
  onLlmStart?: () => void;
  onLlmDone?: (durationMs: number) => void;
  onFileFixed?: (path: string) => void;
}

export interface DocStructureReviewOptions {
  callbacks?: DocStructureReviewCallbacks;
  /** Directory to write the full conversation log and action summary. */
  logDir?: string;
}

/**
 * Reads all .md files in outputDir, sends them to Opus for structural review,
 * and overwrites any files that need fixes. Single LLM call.
 */
export async function reviewDocStructure(
  outputDir: string,
  projectRoot: string,
  docsPath: string,
  executor: DocExecutor,
  optionsOrCallbacks?: DocStructureReviewOptions | DocStructureReviewCallbacks,
): Promise<DocStructureReviewResult> {
  // Accept both { callbacks, logDir } and bare callbacks for backwards compat
  const opts: DocStructureReviewOptions =
    optionsOrCallbacks && ('onCollected' in optionsOrCallbacks || 'onLlmStart' in optionsOrCallbacks || 'onLlmDone' in optionsOrCallbacks || 'onFileFixed' in optionsOrCallbacks)
      ? { callbacks: optionsOrCallbacks as DocStructureReviewCallbacks }
      : (optionsOrCallbacks as DocStructureReviewOptions) ?? {};
  const { callbacks, logDir } = opts;

  const files = collectMarkdownFiles(outputDir);
  if (files.length === 0) return { filesScanned: 0, filesFixed: 0, fixedPaths: [], costUsd: 0 };

  const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);
  callbacks?.onCollected?.(files.length, Math.round(totalSize / 1024));

  // Build the user message with all file contents
  const userParts: string[] = [`# Documentation files (${files.length} total)\n`];
  for (const file of files) {
    const relPath = relative(outputDir, file.fullPath);
    userParts.push(`## FILE: ${relPath}\n\`\`\`markdown\n${file.content}\n\`\`\`\n`);
  }
  const userMessage = userParts.join('\n');

  callbacks?.onLlmStart?.();
  const llmStart = Date.now();
  const timestamp = new Date().toISOString();

  const system = resolveSystemPrompt('doc-generation.structure-review');
  const result = await executor({ system, user: userMessage, model: 'opus' });

  const durationMs = Date.now() - llmStart;
  callbacks?.onLlmDone?.(durationMs);

  // Parse corrections from JSON response
  const jsonStr = extractJson(result.text);

  let corrections: Array<{ path: string; content: string }> = [];
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr) as unknown;
      if (Array.isArray(parsed)) corrections = parsed as Array<{ path: string; content: string }>;
    } catch {
      // leave corrections empty
    }
  }

  // Apply corrections
  const fixedPaths: string[] = [];
  const resolvedOutputDir = resolve(outputDir);
  for (const fix of corrections) {
    if (!fix.path || typeof fix.content !== 'string') continue;
    const fullPath = join(outputDir, fix.path);
    const resolvedFull = resolve(fullPath);
    if (!resolvedFull.startsWith(resolvedOutputDir + sep) && resolvedFull !== resolvedOutputDir) continue;
    assertSafeOutputPath(fullPath, projectRoot, docsPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, fix.content, 'utf-8');
    fixedPaths.push(fix.path);
    callbacks?.onFileFixed?.(fix.path);
  }

  const reviewResult: DocStructureReviewResult = {
    filesScanned: files.length,
    filesFixed: fixedPaths.length,
    fixedPaths,
    costUsd: result.costUsd,
  };

  // Write conversation log
  if (logDir) {
    mkdirSync(logDir, { recursive: true });

    // Full conversation (system + user + assistant)
    const convoLines: string[] = [
      `# Conversation: structure-review`,
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| Model | opus |`,
      `| Timestamp | ${timestamp} |`,
      `| Duration | ${(durationMs / 1000).toFixed(1)}s |`,
      `| Cost | $${result.costUsd.toFixed(4)} |`,
      `| Files scanned | ${files.length} |`,
      `| Files fixed | ${fixedPaths.length} |`,
      '',
      '---',
      '',
      '## System',
      '',
      system,
      '',
      '---',
      '',
      '## User',
      '',
      userMessage,
      '',
      '---',
      '',
      '## Assistant',
      '',
      result.text,
      '',
      '---',
      '',
      `## Result`,
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Success | ${fixedPaths.length >= 0 ? 'true' : 'false'} |`,
      `| Corrections parsed | ${corrections.length} |`,
      `| Corrections applied | ${fixedPaths.length} |`,
      `| Cost | $${result.costUsd.toFixed(4)} |`,
    ];
    writeFileSync(join(logDir, 'conversation.md'), convoLines.join('\n'), 'utf-8');

    // Action summary (compact, for quick review)
    const summaryLines: string[] = [
      `# Structure Review Summary`,
      '',
      `- **Timestamp:** ${timestamp}`,
      `- **Duration:** ${(durationMs / 1000).toFixed(1)}s`,
      `- **Cost:** $${result.costUsd.toFixed(4)}`,
      `- **Files scanned:** ${files.length}`,
      `- **Files fixed:** ${fixedPaths.length}`,
      '',
    ];
    if (fixedPaths.length > 0) {
      summaryLines.push('## Fixed files', '');
      for (const p of fixedPaths) {
        summaryLines.push(`- \`${p}\``);
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
