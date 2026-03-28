// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Semaphore } from './sdk-semaphore.js';
import { executeDocPrompts, type DocLlmResult } from './doc-llm-executor.js';
import type { PagePrompt } from './doc-generator.js';

/**
 * Story 29.17: Execution LLM et ecriture du contenu documentaire
 *
 * Tests for the doc generation executor that sends PagePrompts to the SDK
 * and writes the LLM response to .anatoly/docs/.
 */

function makePrompt(pagePath: string, content = 'Test content'): PagePrompt {
  return {
    pagePath,
    system: 'You are a documentation writer.',
    user: `Write docs for ${pagePath}`,
    model: 'haiku',
  };
}

describe('executeDocPrompts', () => {
  let tempDir: string;
  let outputDir: string;
  let semaphore: Semaphore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'doc-llm-'));
    outputDir = join(tempDir, '.anatoly', 'docs');
    mkdirSync(outputDir, { recursive: true });
    semaphore = new Semaphore(4);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- AC1: Each PagePrompt sent to SDK, content written to .anatoly/docs/ ---
  it('should execute prompts via SDK and write content to output files', async () => {
    const prompts: PagePrompt[] = [
      makePrompt('05-Modules/core.md'),
      makePrompt('01-Getting-Started/01-Overview.md'),
    ];

    // Mock SDK executor that returns markdown content
    const mockExecutor = vi.fn()
      .mockResolvedValueOnce({ text: '# core\n\nCore module docs.', costUsd: 0.001 })
      .mockResolvedValueOnce({ text: '# Overview\n\nProject overview.', costUsd: 0.001 });

    const result = await executeDocPrompts({
      prompts,
      outputDir,
      projectRoot: tempDir,
      semaphore,
      executor: mockExecutor,
    });

    // Both pages written
    expect(result.pagesWritten).toBe(2);
    expect(result.pagesFailed).toBe(0);

    // Files exist with LLM content
    const coreContent = readFileSync(join(outputDir, '05-Modules/core.md'), 'utf-8');
    expect(coreContent).toBe('# core\n\nCore module docs.');

    const overviewContent = readFileSync(join(outputDir, '01-Getting-Started/01-Overview.md'), 'utf-8');
    expect(overviewContent).toBe('# Overview\n\nProject overview.');

    // SDK was called with correct prompts
    expect(mockExecutor).toHaveBeenCalledTimes(2);
    expect(mockExecutor).toHaveBeenCalledWith(expect.objectContaining({
      system: 'You are a documentation writer.',
      model: 'haiku',
    }));
  });

  // --- AC2: Respects sdkConcurrency semaphore budget ---
  it('should respect semaphore concurrency limit', async () => {
    const smallSemaphore = new Semaphore(2);
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const prompts = Array.from({ length: 6 }, (_, i) =>
      makePrompt(`05-Modules/mod-${i}.md`),
    );

    const slowExecutor = vi.fn().mockImplementation(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Simulate LLM latency
      await new Promise(r => setTimeout(r, 50));
      currentConcurrent--;
      return { text: '# Module\n\nDocs.', costUsd: 0.0005 };
    });

    await executeDocPrompts({
      prompts,
      outputDir,
      projectRoot: tempDir,
      semaphore: smallSemaphore,
      executor: slowExecutor,
    });

    // Should never exceed semaphore capacity
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(slowExecutor).toHaveBeenCalledTimes(6);
  });

  // --- AC3: 0 LLM calls when prompts array is empty (cache hit 100%) ---
  it('should make 0 LLM calls when prompts array is empty', async () => {
    const mockExecutor = vi.fn();

    const result = await executeDocPrompts({
      prompts: [],
      outputDir,
      projectRoot: tempDir,
      semaphore,
      executor: mockExecutor,
    });

    expect(result.pagesWritten).toBe(0);
    expect(result.pagesFailed).toBe(0);
    expect(result.totalCostUsd).toBe(0);
    expect(mockExecutor).not.toHaveBeenCalled();
  });

  // --- AC4: LLM failure on one page doesn't block others ---
  it('should continue generating other pages when one fails', async () => {
    const prompts: PagePrompt[] = [
      makePrompt('05-Modules/good1.md'),
      makePrompt('05-Modules/bad.md'),
      makePrompt('05-Modules/good2.md'),
    ];

    const mockExecutor = vi.fn()
      .mockResolvedValueOnce({ text: '# Good 1\n\nWorks.', costUsd: 0.001 })
      .mockRejectedValueOnce(new Error('SDK rate limit exceeded'))
      .mockResolvedValueOnce({ text: '# Good 2\n\nAlso works.', costUsd: 0.001 });

    const result = await executeDocPrompts({
      prompts,
      outputDir,
      projectRoot: tempDir,
      semaphore,
      executor: mockExecutor,
    });

    // 2 succeeded, 1 failed
    expect(result.pagesWritten).toBe(2);
    expect(result.pagesFailed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].pagePath).toBe('05-Modules/bad.md');
    expect(result.errors[0].error).toContain('rate limit');

    // Good pages were written
    expect(readFileSync(join(outputDir, '05-Modules/good1.md'), 'utf-8')).toBe('# Good 1\n\nWorks.');
    expect(readFileSync(join(outputDir, '05-Modules/good2.md'), 'utf-8')).toBe('# Good 2\n\nAlso works.');
  });

  it('should release semaphore slot even on failure', async () => {
    const tightSemaphore = new Semaphore(1);
    const prompts: PagePrompt[] = [
      makePrompt('05-Modules/fail.md'),
      makePrompt('05-Modules/pass.md'),
    ];

    const mockExecutor = vi.fn()
      .mockRejectedValueOnce(new Error('SDK error'))
      .mockResolvedValueOnce({ text: '# Pass\n\nOK.', costUsd: 0.001 });

    const result = await executeDocPrompts({
      prompts,
      outputDir,
      projectRoot: tempDir,
      semaphore: tightSemaphore,
      executor: mockExecutor,
    });

    // Both called — slot was released after failure
    expect(mockExecutor).toHaveBeenCalledTimes(2);
    expect(result.pagesWritten).toBe(1);
    expect(result.pagesFailed).toBe(1);
  });

  // --- AC5: Cost tracking ---
  it('should accumulate total cost from all LLM calls', async () => {
    const prompts: PagePrompt[] = [
      makePrompt('05-Modules/a.md'),
      makePrompt('05-Modules/b.md'),
      makePrompt('05-Modules/c.md'),
    ];

    const mockExecutor = vi.fn()
      .mockResolvedValueOnce({ text: '# A', costUsd: 0.0012 })
      .mockResolvedValueOnce({ text: '# B', costUsd: 0.0008 })
      .mockResolvedValueOnce({ text: '# C', costUsd: 0.0015 });

    const result = await executeDocPrompts({
      prompts,
      outputDir,
      projectRoot: tempDir,
      semaphore,
      executor: mockExecutor,
    });

    expect(result.totalCostUsd).toBeCloseTo(0.0035, 4);
    expect(result.pagesWritten).toBe(3);
  });

  // --- Callback hooks ---
  it('should call onPageComplete for each successful page', async () => {
    const prompts: PagePrompt[] = [
      makePrompt('05-Modules/core.md'),
    ];

    const mockExecutor = vi.fn()
      .mockResolvedValueOnce({ text: '# Core', costUsd: 0.001 });

    const completed: string[] = [];
    await executeDocPrompts({
      prompts,
      outputDir,
      projectRoot: tempDir,
      semaphore,
      executor: mockExecutor,
      onPageComplete: (pagePath) => completed.push(pagePath),
    });

    expect(completed).toEqual(['05-Modules/core.md']);
  });

  it('should call onPageError for each failed page', async () => {
    const prompts: PagePrompt[] = [
      makePrompt('05-Modules/broken.md'),
    ];

    const mockExecutor = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'));

    const errors: Array<{ pagePath: string; error: string }> = [];
    await executeDocPrompts({
      prompts,
      outputDir,
      projectRoot: tempDir,
      semaphore,
      executor: mockExecutor,
      onPageError: (pagePath, err) => errors.push({ pagePath, error: err.message }),
    });

    expect(errors).toEqual([{ pagePath: '05-Modules/broken.md', error: 'timeout' }]);
  });

  it('should create subdirectories for nested page paths', async () => {
    const prompts: PagePrompt[] = [
      makePrompt('02-Architecture/03-Data-Flow.md'),
    ];

    const mockExecutor = vi.fn()
      .mockResolvedValueOnce({ text: '# Data Flow\n\nDiagram here.', costUsd: 0.001 });

    await executeDocPrompts({
      prompts,
      outputDir,
      projectRoot: tempDir,
      semaphore,
      executor: mockExecutor,
    });

    const content = readFileSync(join(outputDir, '02-Architecture/03-Data-Flow.md'), 'utf-8');
    expect(content).toBe('# Data Flow\n\nDiagram here.');
  });
});
