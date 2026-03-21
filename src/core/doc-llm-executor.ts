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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Semaphore } from './sdk-semaphore.js';

// --- Public interfaces ---

export interface DocPrompt {
  pagePath: string;
  system: string;
  user: string;
  model: string;
}

export interface ExecutorResult {
  text: string;
  costUsd: number;
}

export type DocExecutor = (prompt: { system: string; user: string; model: string }) => Promise<ExecutorResult>;

export interface ExecuteDocPromptsParams {
  prompts: DocPrompt[];
  outputDir: string;
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
  const { prompts, outputDir, semaphore, executor, onPageComplete, onPageError } = params;

  if (prompts.length === 0) {
    return { pagesWritten: 0, pagesFailed: 0, totalCostUsd: 0, errors: [] };
  }

  const results = await Promise.allSettled(
    prompts.map(prompt => executeOnePage(prompt, outputDir, semaphore, executor, onPageComplete, onPageError)),
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

    // Ensure subdirectory exists
    const fullPath = join(outputDir, prompt.pagePath);
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
