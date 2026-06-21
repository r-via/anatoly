// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi } from 'vitest';
import { parseTestConfig } from '../../../schemas/test-fixtures.js';
import { buildUtilitySystemPrompt, buildUtilityUserMessage, UtilityEvaluator } from './utility.js';
import * as evaluator from '../evaluator.js';
import type { AxisContext } from '../contract.js';
import type { Task } from '../../../schemas/task.js';
import type { UsageGraph } from '../../scanning/index.js';
import type { Config } from '../../../schemas/config.js';

const mockTask: Task = {
  version: 1,
  file: 'src/utils/format.ts',
  hash: 'abc123',
  symbols: [
    { name: 'formatNumber', kind: 'function', exported: true, line_start: 1, line_end: 10 },
    { name: 'padLeft', kind: 'function', exported: false, line_start: 12, line_end: 20 },
    { name: 'MAX_WIDTH', kind: 'constant', exported: true, line_start: 22, line_end: 22 },
  ],
  scanned_at: '2026-02-25T00:00:00Z',
};

const mockConfig: Config = parseTestConfig({});

const mockUsageGraph: UsageGraph = {
  usages: new Map([
    ['formatNumber::src/utils/format.ts', new Set(['src/core/reporter.ts', 'src/commands/status.ts'])],
    // MAX_WIDTH has 0 importers → DEAD
  ]),
  typeOnlyUsages: new Map(),
  intraFileRefs: new Map(),
  noImportFiles: new Set(),
};

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task: mockTask,
    fileContent: 'export function formatNumber(n: number): string {\n  return padLeft(n.toString());\n}\n\nfunction padLeft(s: string): string {\n  return s.padStart(10);\n}\n\nexport const MAX_WIDTH = 80;\n',
    config: mockConfig,
    projectRoot: '/tmp/test',
    usageGraph: mockUsageGraph,
    ...overrides,
  };
}

describe('buildUtilitySystemPrompt', () => {
  it('should produce a focused prompt mentioning only utility', () => {
    const prompt = buildUtilitySystemPrompt();
    expect(prompt).toContain('utility');
    expect(prompt).toContain('USED');
    expect(prompt).toContain('DEAD');
    expect(prompt).toContain('LOW_VALUE');
    expect(prompt).not.toContain('correction');
    expect(prompt).not.toContain('overengineering');
    expect(prompt.split('\n').length).toBeLessThan(50);
  });
});

describe('buildUtilityUserMessage', () => {
  it('should include file content and symbols', () => {
    const msg = buildUtilityUserMessage(createCtx());
    expect(msg).toContain('src/utils/format.ts');
    expect(msg).toContain('formatNumber');
    expect(msg).toContain('padLeft');
    expect(msg).toContain('MAX_WIDTH');
  });

  it('should include usage graph data for exported symbols', () => {
    const msg = buildUtilityUserMessage(createCtx());
    expect(msg).toContain('Pre-computed Import Analysis');
    expect(msg).toContain('formatNumber (exported): runtime-imported by 2 files');
    expect(msg).toContain('MAX_WIDTH (exported): imported by 0 files');
    expect(msg).toContain('LIKELY DEAD');
  });

  it('should mark non-exported symbols as internal', () => {
    const msg = buildUtilityUserMessage(createCtx());
    expect(msg).toContain('padLeft (not exported): internal only');
  });

  it('surfaces transitive in-file usage for a private helper called by a used export', () => {
    const graph: UsageGraph = {
      usages: new Map([['formatNumber::src/utils/format.ts', new Set(['src/core/reporter.ts'])]]),
      typeOnlyUsages: new Map(),
      intraFileRefs: new Map([['padLeft::src/utils/format.ts', new Set(['formatNumber'])]]),
      noImportFiles: new Set(),
    };
    const msg = buildUtilityUserMessage(createCtx({ usageGraph: graph }));
    expect(msg).toContain('padLeft (not exported): referenced in-file by formatNumber');
    expect(msg).toContain('USED (transitively)');
  });

  it('keeps "internal only" when the in-file referencer is not itself cross-file alive', () => {
    // formatNumber references padLeft, but formatNumber has no importers, so the
    // transitive-liveness filter drops it — no false USED signal.
    const graph: UsageGraph = {
      usages: new Map(),
      typeOnlyUsages: new Map(),
      intraFileRefs: new Map([['padLeft::src/utils/format.ts', new Set(['formatNumber'])]]),
      noImportFiles: new Set(),
    };
    const msg = buildUtilityUserMessage(createCtx({ usageGraph: graph }));
    expect(msg).toContain('padLeft (not exported): internal only');
  });

  it('should work without usage graph', () => {
    const msg = buildUtilityUserMessage(createCtx({ usageGraph: undefined }));
    expect(msg).not.toContain('Pre-computed Import Analysis');
    expect(msg).toContain('formatNumber');
  });
});

describe('UtilityEvaluator.evaluate — graph-proven liveness is authoritative', () => {
  it('vetoes an LLM DEAD that contradicts a graph-proven USED', async () => {
    // padLeft is non-exported with no in-file liveness → the graph cannot
    // resolve it → the file is sent to the LLM. The LLM (single-file view)
    // wrongly returns DEAD for formatNumber, which the graph proved USED via 2
    // cross-file importers. The merge must keep USED.
    const spy = vi.spyOn(evaluator, 'runSingleTurnQuery').mockResolvedValue({
      data: {
        symbols: [
          { name: 'formatNumber', line_start: 1, line_end: 10, utility: 'DEAD', confidence: 80, detail: 'no local callers' },
          { name: 'padLeft', line_start: 12, line_end: 20, utility: 'USED', confidence: 80, detail: 'called by formatNumber' },
          { name: 'MAX_WIDTH', line_start: 22, line_end: 22, utility: 'DEAD', confidence: 80, detail: 'unused' },
        ],
      },
      costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, transcript: '',
    } as unknown as Awaited<ReturnType<typeof evaluator.runSingleTurnQuery>>);

    const result = await new UtilityEvaluator().evaluate(createCtx(), new AbortController());
    spy.mockRestore();

    const fn = result.symbols.find((s) => s.name === 'formatNumber')!;
    expect(fn.value).toBe('USED');
    expect(fn.detail).toContain('Runtime-imported'); // kept the graph verdict, not the LLM prose
    // A symbol the graph could not resolve is still decided by the LLM.
    expect(result.symbols.find((s) => s.name === 'padLeft')!.value).toBe('USED');
  });

  it('still lets the LLM refine a graph-USED symbol to a non-DEAD verdict (LOW_VALUE)', async () => {
    const spy = vi.spyOn(evaluator, 'runSingleTurnQuery').mockResolvedValue({
      data: {
        symbols: [
          { name: 'formatNumber', line_start: 1, line_end: 10, utility: 'LOW_VALUE', confidence: 80, detail: 'thin wrapper' },
          { name: 'padLeft', line_start: 12, line_end: 20, utility: 'USED', confidence: 80, detail: 'used' },
          { name: 'MAX_WIDTH', line_start: 22, line_end: 22, utility: 'DEAD', confidence: 80, detail: 'unused' },
        ],
      },
      costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, transcript: '',
    } as unknown as Awaited<ReturnType<typeof evaluator.runSingleTurnQuery>>);

    const result = await new UtilityEvaluator().evaluate(createCtx(), new AbortController());
    spy.mockRestore();

    // Not a DEAD reversal → the LLM refinement is kept.
    expect(result.symbols.find((s) => s.name === 'formatNumber')!.value).toBe('LOW_VALUE');
  });
});
