// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  estimateProject,
  loadTasks,
  countTokens,
  formatTokenCount,
  estimateFileSeconds,
  estimateSequentialSeconds,
  estimateMinutesWithConcurrency,
  forecastRun,
  BASE_SECONDS,
  SECONDS_PER_SYMBOL,
  CONCURRENCY_EFFICIENCY,
  AXIS_COUNT,
} from './estimator.js';
import { ALL_AXIS_IDS } from './axes/index.js';
import type { Task } from '../schemas/task.js';
import type { CalibrationData } from './calibration.js';
import { PRICING_PATHS, _resetPricingCache } from '../utils/pricing-cache.js';
import { NLP_TOKENS_PER_FUNCTION } from '../rag/embed-estimator.js';

describe('countTokens', () => {
  it('should count tokens in a string', () => {
    const count = countTokens('Hello world');
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it('should return 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });
});

describe('formatTokenCount', () => {
  it('should format millions', () => {
    expect(formatTokenCount(1_200_000)).toBe('~1.2M');
    expect(formatTokenCount(2_500_000)).toBe('~2.5M');
  });

  it('should format thousands', () => {
    expect(formatTokenCount(340_000)).toBe('~340K');
    expect(formatTokenCount(1_500)).toBe('~2K');
  });

  it('should format small numbers', () => {
    expect(formatTokenCount(500)).toBe('~500');
    expect(formatTokenCount(0)).toBe('~0');
  });
});

describe('loadTasks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-est-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return empty array when tasks directory does not exist', () => {
    const tasks = loadTasks(tempDir);
    expect(tasks).toEqual([]);
  });

  it('should load task files from tasks directory', () => {
    const tasksDir = join(tempDir, '.anatoly', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, 'src-index.task.json'),
      JSON.stringify({
        version: 1,
        file: 'src/index.ts',
        hash: 'abc123',
        symbols: [{ name: 'main', kind: 'function', exported: true, line_start: 1, line_end: 5 }],
        scanned_at: '2026-01-01T00:00:00Z',
      }),
    );

    const tasks = loadTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].file).toBe('src/index.ts');
  });
});

describe('estimateProject', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-est2-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return zeros when no tasks exist', () => {
    const result = estimateProject(tempDir);
    expect(result.files).toBe(0);
    expect(result.symbols).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedMinutes).toBe(0);
    expect(result.estimatedCalls).toBe(0);
  });

  it('should estimate tokens from task files and source content', () => {
    // Create source file
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'index.ts'),
      `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
    );

    // Create task file
    const tasksDir = join(tempDir, '.anatoly', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, 'src-index.task.json'),
      JSON.stringify({
        version: 1,
        file: 'src/index.ts',
        hash: 'abc',
        symbols: [
          { name: 'greet', kind: 'function', exported: true, line_start: 1, line_end: 3 },
        ],
        scanned_at: '2026-01-01T00:00:00Z',
      }),
    );

    const result = estimateProject(tempDir);
    expect(result.files).toBe(1);
    expect(result.symbols).toBe(1);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.estimatedMinutes).toBeGreaterThan(0);
    expect(result.estimatedCalls).toBe(AXIS_COUNT); // 7 axes per file
  });

  it('should handle deleted source files gracefully', () => {
    // Task without corresponding source file
    const tasksDir = join(tempDir, '.anatoly', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, 'src-deleted.task.json'),
      JSON.stringify({
        version: 1,
        file: 'src/deleted.ts',
        hash: 'abc',
        symbols: [
          { name: 'foo', kind: 'function', exported: true, line_start: 1, line_end: 10 },
        ],
        scanned_at: '2026-01-01T00:00:00Z',
      }),
    );

    const result = estimateProject(tempDir);
    expect(result.files).toBe(1);
    expect(result.inputTokens).toBeGreaterThan(0);
  });
});

describe('estimateFileSeconds', () => {
  it('should return BASE_SECONDS for 0 symbols', () => {
    expect(estimateFileSeconds(0)).toBe(BASE_SECONDS);
  });

  it('should scale with symbol count', () => {
    // 5 symbols: 4 + 5 × 0.8 = 8s
    expect(estimateFileSeconds(5)).toBe(BASE_SECONDS + 5 * SECONDS_PER_SYMBOL);
    expect(estimateFileSeconds(5)).toBeCloseTo(8);
  });

  it('should estimate more time for files with many symbols', () => {
    // 20 symbols: 4 + 20 × 0.8 = 20s
    expect(estimateFileSeconds(20)).toBeCloseTo(20);
  });
});

describe('estimateSequentialSeconds', () => {
  it('should return 0 for empty task list', () => {
    expect(estimateSequentialSeconds([])).toBe(0);
  });

  it('should sum weighted seconds across tasks', () => {
    const tasks = [
      { file: 'a.ts', symbols: new Array(5) },
      { file: 'b.ts', symbols: new Array(10) },
    ] as { file: string; symbols: unknown[] }[];
    // a: 4 + 5×0.8 = 8, b: 4 + 10×0.8 = 12 → total 20
    const result = estimateSequentialSeconds(tasks as import('../schemas/task.js').Task[]);
    expect(result).toBeCloseTo(20);
  });
});

describe('estimateMinutesWithConcurrency', () => {
  it('should return 0 for 0 seconds', () => {
    expect(estimateMinutesWithConcurrency(0, 3)).toBe(0);
  });

  it('should ceil to minutes for sequential (concurrency 1)', () => {
    // 80s sequential → ceil(80/60) = 2 min
    expect(estimateMinutesWithConcurrency(80, 1)).toBe(2);
  });

  it('should apply concurrency efficiency factor', () => {
    // 120s / (3 × 0.75) = 120 / 2.25 = 53.3s → ceil(53.3/60) = 1 min
    expect(estimateMinutesWithConcurrency(120, 3)).toBe(1);
  });

  it('should not over-discount with high concurrency', () => {
    // 600s / (5 × 0.75) = 600 / 3.75 = 160s → ceil(160/60) = 3 min
    expect(estimateMinutesWithConcurrency(600, 5)).toBe(3);
  });
});

describe('constants', () => {
  it('should have expected values', () => {
    expect(BASE_SECONDS).toBe(4);
    expect(SECONDS_PER_SYMBOL).toBe(0.8);
    expect(CONCURRENCY_EFFICIENCY).toBe(0.75);
    expect(AXIS_COUNT).toBe(ALL_AXIS_IDS.length);
  });
});

// ---------------------------------------------------------------------------
// forecastRun — decision-grade Forecast block (Pass 1: NLP summary in LLM count)
// ---------------------------------------------------------------------------

describe('forecastRun', () => {
  let projectRoot: string;

  function seedPricing(
    models: Record<string, { input: number; output: number; cacheReadInput?: number; cacheCreationInput?: number }>,
  ): void {
    mkdirSync(resolve(projectRoot, '.anatoly'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, PRICING_PATHS.normalized),
      JSON.stringify({
        generated_at: new Date().toISOString(),
        models: Object.fromEntries(
          Object.entries(models).map(([k, v]) => [k, { ...v, source: 'litellm' }]),
        ),
      }),
    );
  }

  function makeTask(file: string, content: string): Task {
    mkdirSync(resolve(projectRoot, 'src'), { recursive: true });
    writeFileSync(resolve(projectRoot, file), content);
    return {
      version: 1,
      file,
      hash: 'h',
      symbols: [{ name: 'fn', kind: 'function', exported: true, line_start: 1, line_end: 3 }],
      scanned_at: '2026-01-01T00:00:00Z',
    };
  }

  const emptyCal: CalibrationData = { version: 1, updatedAt: '', axes: {} };

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'anatoly-forecast-'));
    _resetPricingCache();
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    _resetPricingCache();
  });

  it('does not add summary tokens when summaryModel is omitted', () => {
    seedPricing({ 'anthropic/claude-sonnet-4-6': { input: 3, output: 15 } });
    const tasks = [makeTask('src/a.ts', 'export function fn() { return 42; }\n')];
    const baseline = forecastRun({
      projectRoot,
      evalTasks: tasks,
      totalFiles: 1,
      axes: [{ id: 'utility', model: 'anthropic/claude-sonnet-4-6' }],
      embed: { codeTokens: 1000, codeUnits: 5, nlpTokens: 200, nlpUnits: 10 },
      // summaryModel intentionally omitted
      calibration: emptyCal,
      concurrency: 1,
      ragEnabled: true,
      deliberation: false,
    });
    // Just the axis pass — no summarizer contribution.
    const expectedAxisOnly = forecastRun({
      projectRoot,
      evalTasks: tasks,
      totalFiles: 1,
      axes: [{ id: 'utility', model: 'anthropic/claude-sonnet-4-6' }],
      calibration: emptyCal,
      concurrency: 1,
      ragEnabled: false,
      deliberation: false,
    });
    expect(baseline.llm.inputTokens).toBe(expectedAxisOnly.llm.inputTokens);
    expect(baseline.llm.outputTokens).toBe(expectedAxisOnly.llm.outputTokens);
    expect(baseline.llm.costUsd).toBeCloseTo(expectedAxisOnly.llm.costUsd, 6);
  });

  it('folds NLP summarizer tokens and cost into the LLM count when summaryModel is set', () => {
    seedPricing({
      'anthropic/claude-sonnet-4-6': { input: 3, output: 15 },
      'anthropic/claude-haiku-4-5': { input: 1, output: 5 },
    });
    const tasks = [makeTask('src/a.ts', 'export function fn() { return 42; }\n')];

    const without = forecastRun({
      projectRoot,
      evalTasks: tasks,
      totalFiles: 1,
      axes: [{ id: 'utility', model: 'anthropic/claude-sonnet-4-6' }],
      embed: { codeTokens: 10_000, codeUnits: 50, nlpTokens: 1000, nlpUnits: 80 },
      calibration: emptyCal,
      concurrency: 1,
      ragEnabled: true,
      deliberation: false,
    });

    const withSummary = forecastRun({
      projectRoot,
      evalTasks: tasks,
      totalFiles: 1,
      axes: [{ id: 'utility', model: 'anthropic/claude-sonnet-4-6' }],
      embed: { codeTokens: 10_000, codeUnits: 50, nlpTokens: 1000, nlpUnits: 80 },
      summaryModel: 'anthropic/claude-haiku-4-5',
      calibration: emptyCal,
      concurrency: 1,
      ragEnabled: true,
      deliberation: false,
    });

    // Summary input ≈ codeTokens (10 000), output ≈ codeUnits × NLP_TOKENS_PER_FUNCTION (50 × 200 = 10 000).
    expect(withSummary.llm.inputTokens).toBe(without.llm.inputTokens + 10_000);
    expect(withSummary.llm.outputTokens).toBe(
      without.llm.outputTokens + 50 * NLP_TOKENS_PER_FUNCTION,
    );

    // Cost added under the summarizer's short model key (haiku-4-5).
    const expectedSummaryCost = (10_000 * 1 + 10_000 * 5) / 1_000_000; // $0.06
    expect(withSummary.llm.costUsd).toBeCloseTo(without.llm.costUsd + expectedSummaryCost, 6);
    expect(withSummary.llm.costByModel['haiku-4-5']).toBeCloseTo(expectedSummaryCost, 6);
  });

  it('skips summary contribution when ragEnabled but embed has no code units', () => {
    seedPricing({
      'anthropic/claude-sonnet-4-6': { input: 3, output: 15 },
      'anthropic/claude-haiku-4-5': { input: 1, output: 5 },
    });
    const tasks = [makeTask('src/a.ts', 'const x = 1;\n')];

    const result = forecastRun({
      projectRoot,
      evalTasks: tasks,
      totalFiles: 1,
      axes: [{ id: 'utility', model: 'anthropic/claude-sonnet-4-6' }],
      embed: { codeTokens: 0, codeUnits: 0, nlpTokens: 500, nlpUnits: 5 },
      summaryModel: 'anthropic/claude-haiku-4-5',
      calibration: emptyCal,
      concurrency: 1,
      ragEnabled: true,
      deliberation: false,
    });
    expect(result.llm.costByModel['haiku-4-5']).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Pass 2 — embed cost (external SDK models)
  // ---------------------------------------------------------------------

  it('computes embed cost when codeModel/nlpModel are external (priced) models', () => {
    seedPricing({
      'anthropic/claude-sonnet-4-6': { input: 3, output: 15 },
      'voyage/voyage-code-3': { input: 0.18, output: 0 },
      'mistral/codestral-embed-2505': { input: 0.15, output: 0 },
    });
    const tasks = [makeTask('src/a.ts', 'export function fn() { return 1; }\n')];
    const result = forecastRun({
      projectRoot,
      evalTasks: tasks,
      totalFiles: 1,
      axes: [{ id: 'utility', model: 'anthropic/claude-sonnet-4-6' }],
      embed: {
        codeTokens: 1_000_000, codeUnits: 100,
        nlpTokens: 500_000, nlpUnits: 50,
        codeModel: 'voyage/voyage-code-3',
        nlpModel: 'mistral/codestral-embed-2505',
      },
      calibration: emptyCal,
      concurrency: 1,
      ragEnabled: true,
      deliberation: false,
    });

    // 1M code-embed tokens × $0.18/M = $0.18 ; 0.5M nlp-embed × $0.15/M = $0.075.
    const expectedEmbedCost = 0.18 + 0.075;
    expect(result.totalCostUsd).toBeCloseTo(result.llm.costUsd + expectedEmbedCost, 6);
    expect(result.totalCostUsd - result.llm.costUsd).toBeCloseTo(expectedEmbedCost, 6);
  });

  it('reports embed cost = 0 when codeModel/nlpModel are local (no pricing entry)', () => {
    seedPricing({ 'anthropic/claude-sonnet-4-6': { input: 3, output: 15 } });
    const tasks = [makeTask('src/a.ts', 'export function fn() { return 1; }\n')];
    const result = forecastRun({
      projectRoot,
      evalTasks: tasks,
      totalFiles: 1,
      axes: [{ id: 'utility', model: 'anthropic/claude-sonnet-4-6' }],
      embed: {
        codeTokens: 1_000_000, codeUnits: 100,
        nlpTokens: 500_000, nlpUnits: 50,
        // Local model ids — absent from the seeded pricing, so calculateCost
        // returns 0 (correct: ONNX/GGUF embeddings have no API price).
        codeModel: 'jinaai/jina-embeddings-v2-base-code',
        nlpModel: 'Xenova/all-MiniLM-L6-v2',
      },
      calibration: emptyCal,
      concurrency: 1,
      ragEnabled: true,
      deliberation: false,
    });
    expect(result.totalCostUsd).toBeCloseTo(result.llm.costUsd, 6);
  });

  it('reports embed cost = 0 when codeModel/nlpModel are omitted (Pass 1 backwards-compat)', () => {
    seedPricing({
      'anthropic/claude-sonnet-4-6': { input: 3, output: 15 },
      'voyage/voyage-code-3': { input: 0.18, output: 0 },
    });
    const tasks = [makeTask('src/a.ts', 'export function fn() { return 1; }\n')];
    const result = forecastRun({
      projectRoot,
      evalTasks: tasks,
      totalFiles: 1,
      axes: [{ id: 'utility', model: 'anthropic/claude-sonnet-4-6' }],
      embed: { codeTokens: 1_000_000, codeUnits: 100, nlpTokens: 500_000, nlpUnits: 50 },
      // codeModel / nlpModel intentionally omitted — even with priced models
      // available in the cache, no model id ⇒ no embed cost computed.
      calibration: emptyCal,
      concurrency: 1,
      ragEnabled: true,
      deliberation: false,
    });
    expect(result.totalCostUsd).toBeCloseTo(result.llm.costUsd, 6);
  });

  // ---------------------------------------------------------------------
  // Pass A — per-step breakdown + cache modeling + doc-gen heuristic
  // ---------------------------------------------------------------------

  describe('per-step breakdown', () => {
    it('produces one step per axis, plus summary, embed, and doc when applicable', () => {
      seedPricing({
        'anthropic/claude-sonnet-4-6': { input: 3, output: 15, cacheReadInput: 0.3, cacheCreationInput: 3.75 },
        'anthropic/claude-haiku-4-5': { input: 1, output: 5, cacheReadInput: 0.1, cacheCreationInput: 1.25 },
        'anthropic/claude-opus-4-6': { input: 15, output: 75, cacheReadInput: 1.5, cacheCreationInput: 18.75 },
        'voyage/voyage-code-3': { input: 0.18, output: 0 },
      });
      const tasks = [
        makeTask('src/a.ts', 'export function a() { return 1; }\n'),
        makeTask('src/b.ts', 'export function b() { return 2; }\n'),
      ];
      const result = forecastRun({
        projectRoot,
        evalTasks: tasks,
        totalFiles: 2,
        axes: [
          { id: 'correction', model: 'anthropic/claude-sonnet-4-6' },
          { id: 'utility', model: 'anthropic/claude-haiku-4-5' },
        ],
        embed: {
          codeTokens: 100_000, codeUnits: 50,
          nlpTokens: 50_000, nlpUnits: 25,
          codeModel: 'voyage/voyage-code-3',
        },
        summaryModel: 'anthropic/claude-haiku-4-5',
        docContext: { mode: 'bootstrap', pageCount: 5, scaffoldingModel: 'anthropic/claude-opus-4-6' },
        calibration: emptyCal,
        concurrency: 1,
        ragEnabled: true,
        deliberation: false,
      });

      const ids = result.steps.map(s => `${s.category}:${s.name}`).sort();
      expect(ids).toEqual([
        'axis:correction',
        'axis:utility',
        'embed:code',
        'embed:text',
        'internal-doc:bootstrap',
        'summary:',
      ]);
      // embed nlp has no nlpModel ⇒ cost = 0 but step still surfaces with model 'local'.
      expect(result.steps.find(s => s.category === 'embed' && s.name === 'text')?.model).toBe('local');
      // doc:bootstrap is approximate.
      expect(result.steps.find(s => s.category === 'internal-doc' && s.name === 'bootstrap')?.approximate).toBe(true);
    });

    it('totals are derived from steps (totalCostUsd = sum of step costUsd)', () => {
      seedPricing({
        'anthropic/claude-sonnet-4-6': { input: 3, output: 15, cacheReadInput: 0.3, cacheCreationInput: 3.75 },
        'anthropic/claude-haiku-4-5': { input: 1, output: 5, cacheReadInput: 0.1, cacheCreationInput: 1.25 },
      });
      const tasks = [makeTask('src/a.ts', 'export function fn() { return 1; }\n')];
      const result = forecastRun({
        projectRoot,
        evalTasks: tasks,
        totalFiles: 1,
        axes: [
          { id: 'correction', model: 'anthropic/claude-sonnet-4-6' },
          { id: 'utility', model: 'anthropic/claude-haiku-4-5' },
        ],
        embed: { codeTokens: 1000, codeUnits: 5, nlpTokens: 500, nlpUnits: 3 },
        summaryModel: 'anthropic/claude-haiku-4-5',
        calibration: emptyCal,
        concurrency: 1,
        ragEnabled: true,
        deliberation: false,
      });
      const stepSum = result.steps.reduce((s, x) => s + x.costUsd, 0);
      expect(result.totalCostUsd).toBeCloseTo(stepSum, 6);
    });
  });

  describe('cache modeling', () => {
    it('uses cache rates for cached SYSTEM portion across files (E > 1)', () => {
      // Anthropic-style rates: cache_read = 10% of input, cache_creation = 125%.
      seedPricing({
        'anthropic/claude-sonnet-4-6': {
          input: 3, output: 15, cacheReadInput: 0.3, cacheCreationInput: 3.75,
        },
      });

      // Build 10 identical tasks so cache benefit is measurable.
      const tasks = Array.from({ length: 10 }, (_, i) =>
        makeTask(`src/f${i}.ts`, 'export function fn() { return 1; }\n'),
      );

      const result = forecastRun({
        projectRoot,
        evalTasks: tasks,
        totalFiles: 10,
        axes: [{ id: 'utility', model: 'anthropic/claude-sonnet-4-6' }],
        calibration: emptyCal,
        concurrency: 1,
        ragEnabled: false,
        deliberation: false,
      });

      const axisStep = result.steps[0];
      // 10 files: 1 cache_creation, 9 cache_read on the SYSTEM_PROMPT_TOKENS portion.
      expect(axisStep.cacheCreationTokens ?? 0).toBeGreaterThan(0);
      expect(axisStep.cacheReadTokens ?? 0).toBeGreaterThan(0);
      expect(axisStep.cacheReadTokens ?? 0).toBeGreaterThan(axisStep.cacheCreationTokens ?? 0);
    });

    it('falls back to naive cost for models without cache rates', () => {
      seedPricing({
        // No cacheReadInput / cacheCreationInput keys ⇒ pricing.cacheReadInput
        // is undefined ⇒ calculateCost falls back to inputRate for cache tokens.
        // Net effect: cost is the same as naive (no cache benefit assumed).
        'openai/gpt-5': { input: 5, output: 20 },
      });
      const tasks = Array.from({ length: 10 }, (_, i) =>
        makeTask(`src/f${i}.ts`, 'export function fn() { return 1; }\n'),
      );
      const result = forecastRun({
        projectRoot,
        evalTasks: tasks,
        totalFiles: 10,
        axes: [{ id: 'utility', model: 'openai/gpt-5' }],
        calibration: emptyCal,
        concurrency: 1,
        ragEnabled: false,
        deliberation: false,
      });
      // Naive cost = (totalInput) × inputRate + totalOutput × outputRate.
      // We can't easily compute the exact naive total here, but it must equal
      // the step's total billed input × inputRate (since cache rate falls back).
      const step = result.steps[0];
      const naive = (step.inputTokens + (step.cacheReadTokens ?? 0) + (step.cacheCreationTokens ?? 0)) * 5
        + step.outputTokens * 20;
      expect(step.costUsd * 1_000_000).toBeCloseTo(naive, 4);
    });
  });

  describe('doc-gen step', () => {
    it('uses bootstrap constants when mode = bootstrap', () => {
      seedPricing({
        'anthropic/claude-opus-4-6': {
          input: 15, output: 75, cacheReadInput: 1.5, cacheCreationInput: 18.75,
        },
      });
      const tasks = [makeTask('src/a.ts', 'export function fn() { return 1; }\n')];
      const result = forecastRun({
        projectRoot,
        evalTasks: tasks,
        totalFiles: 1,
        axes: [],
        docContext: { mode: 'bootstrap', pageCount: 10, scaffoldingModel: 'anthropic/claude-opus-4-6' },
        calibration: emptyCal,
        concurrency: 1,
        ragEnabled: false,
        deliberation: false,
      });
      const step = result.steps.find(s => s.category === 'internal-doc' && s.name === 'bootstrap');
      expect(step).toBeDefined();
      expect(step!.approximate).toBe(true);
      // 10 pages × 3000 fresh = 30 000 fresh input.
      expect(step!.inputTokens).toBe(30_000);
      // 10 pages × 7000 cache_read = 70 000.
      expect(step!.cacheReadTokens).toBe(70_000);
    });

    it('skips doc step when pageCount is 0', () => {
      seedPricing({ 'anthropic/claude-opus-4-6': { input: 15, output: 75 } });
      const tasks = [makeTask('src/a.ts', 'export function fn() { return 1; }\n')];
      const result = forecastRun({
        projectRoot,
        evalTasks: tasks,
        totalFiles: 1,
        axes: [],
        docContext: { mode: 'update', pageCount: 0, scaffoldingModel: 'anthropic/claude-opus-4-6' },
        calibration: emptyCal,
        concurrency: 1,
        ragEnabled: false,
        deliberation: false,
      });
      expect(result.steps.find(s => s.category === 'internal-doc')).toBeUndefined();
    });
  });
});
