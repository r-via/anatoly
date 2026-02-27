import { describe, it, expect, vi } from 'vitest';
import { evaluateFile } from './file-evaluator.js';
import type { EvaluateFileOptions } from './file-evaluator.js';
import type { Task } from '../schemas/task.js';
import type { Config } from '../schemas/config.js';
import type { AxisEvaluator, AxisResult } from './axis-evaluator.js';
import { ConfigSchema } from '../schemas/config.js';
import { readFileSync } from 'node:fs';
import * as deliberationModule from './deliberation.js';
import * as axisEvaluatorModule from './axis-evaluator.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => 'export function doWork() { return 42; }\n'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockTask: Task = {
  version: 1,
  file: 'src/core/example.ts',
  hash: 'abc123',
  symbols: [
    { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10 },
  ],
  scanned_at: '2026-02-25T00:00:00Z',
};

const mockConfig: Config = ConfigSchema.parse({});

function makeMockEvaluator(id: string, result: Partial<AxisResult> = {}): AxisEvaluator {
  return {
    id: id as AxisEvaluator['id'],
    defaultModel: 'haiku',
    evaluate: vi.fn(async () => ({
      axisId: id as AxisResult['axisId'],
      symbols: [
        { name: 'doWork', line_start: 1, line_end: 10, value: 'OK', confidence: 90, detail: 'Test result' },
      ],
      actions: [],
      costUsd: 0.001,
      durationMs: 200,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: `## System (init)\n\n**Model:** test-model\n`,
      ...result,
    })),
  };
}

function makeOptions(overrides: Partial<EvaluateFileOptions> = {}): EvaluateFileOptions {
  return {
    projectRoot: '/test/project',
    task: mockTask,
    config: mockConfig,
    evaluators: [makeMockEvaluator('utility'), makeMockEvaluator('correction')],
    abortController: new AbortController(),
    runDir: '/test/project/.anatoly',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateFile', () => {
  it('should produce a ReviewFile from evaluator results', async () => {
    const opts = makeOptions();
    const result = await evaluateFile(opts);

    expect(result.review.version).toBe(2);
    expect(result.review.file).toBe('src/core/example.ts');
    expect(result.review.symbols).toHaveLength(1);
    expect(result.review.symbols[0].name).toBe('doWork');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.transcript).toContain('Axis: utility');
    expect(result.transcript).toContain('Axis: correction');
  });

  it('should call all evaluators in parallel', async () => {
    const eval1 = makeMockEvaluator('utility');
    const eval2 = makeMockEvaluator('correction');
    const opts = makeOptions({ evaluators: [eval1, eval2] });

    await evaluateFile(opts);

    expect(eval1.evaluate).toHaveBeenCalledOnce();
    expect(eval2.evaluate).toHaveBeenCalledOnce();
  });

  it('should read the file content from projectRoot + task.file', async () => {
    const opts = makeOptions({ projectRoot: '/my/project' });
    await evaluateFile(opts);

    expect(readFileSync).toHaveBeenCalledWith(expect.stringContaining('src/core/example.ts'), 'utf-8');
  });

  it('should call onAxisComplete callback for each successful axis', async () => {
    const onAxisComplete = vi.fn();
    const opts = makeOptions({ onAxisComplete });

    await evaluateFile(opts);

    expect(onAxisComplete).toHaveBeenCalledTimes(2);
    expect(onAxisComplete).toHaveBeenCalledWith('utility');
    expect(onAxisComplete).toHaveBeenCalledWith('correction');
  });

  it('should handle evaluator failures gracefully via Promise.allSettled', async () => {
    const failingEvaluator: AxisEvaluator = {
      id: 'tests',
      defaultModel: 'haiku',
      evaluate: vi.fn(async () => { throw new Error('LLM timeout'); }),
    };
    const workingEvaluator = makeMockEvaluator('utility');

    const opts = makeOptions({ evaluators: [workingEvaluator, failingEvaluator] });
    const result = await evaluateFile(opts);

    // Should still produce a review from the successful evaluator
    expect(result.review.version).toBe(2);
    expect(result.review.symbols[0].utility).toBeDefined();
    // Transcript should note the failure
    expect(result.transcript).toContain('FAILED');
    expect(result.transcript).toContain('LLM timeout');
  });

  it('should aggregate costs from all evaluators', async () => {
    const eval1 = makeMockEvaluator('utility', { costUsd: 0.005 });
    const eval2 = makeMockEvaluator('correction', { costUsd: 0.015 });

    const opts = makeOptions({ evaluators: [eval1, eval2] });
    const result = await evaluateFile(opts);

    expect(result.costUsd).toBeCloseTo(0.02, 4);
  });

  it('should skip RAG pre-resolution when ragEnabled is false', async () => {
    const opts = makeOptions({ ragEnabled: false });
    const result = await evaluateFile(opts);

    // Should still work fine without RAG
    expect(result.review.version).toBe(2);
    const evaluator = opts.evaluators[0];
    const ctxArg = (evaluator.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctxArg.preResolvedRag).toBeUndefined();
  });

  it('should extract best_practices data when present', async () => {
    const bpData = {
      score: 8,
      rules: [{ rule_id: 1, rule_name: 'Error handling', status: 'PASS' as const, severity: 'CRITIQUE' as const }],
      suggestions: [],
    };

    const bpEvaluator: AxisEvaluator = {
      id: 'best_practices',
      defaultModel: 'sonnet',
      evaluate: vi.fn(async () => ({
        axisId: 'best_practices' as const,
        symbols: [],
        actions: [],
        costUsd: 0.01,
        durationMs: 1000,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        transcript: '## System\n\n**Model:** test\n',
        _bestPractices: bpData,
      })),
    };

    const opts = makeOptions({ evaluators: [makeMockEvaluator('utility'), bpEvaluator] });
    const result = await evaluateFile(opts);

    expect(result.review.best_practices).toBeDefined();
    expect(result.review.best_practices!.score).toBe(8);
  });

  it('should run deliberation when enabled and needsDeliberation returns true', async () => {
    const needsSpy = vi.spyOn(deliberationModule, 'needsDeliberation').mockReturnValue(true);
    const applySpy = vi.spyOn(deliberationModule, 'applyDeliberation').mockImplementation((review) => ({
      ...review,
      verdict: 'CLEAN',
    }));
    const querySpy = vi.spyOn(axisEvaluatorModule, 'runSingleTurnQuery').mockResolvedValue({
      data: {
        verdict: 'CLEAN',
        symbols: [],
        removed_actions: [],
        reasoning: 'Everything looks fine after deliberation',
      },
      costUsd: 0.05,
      durationMs: 2000,
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: '## Deliberation\n\nOpus output',
    });

    const deliberationConfig = ConfigSchema.parse({ llm: { deliberation: true } });
    const opts = makeOptions({ config: deliberationConfig, deliberation: true });
    const result = await evaluateFile(opts);

    expect(needsSpy).toHaveBeenCalled();
    expect(querySpy).toHaveBeenCalled();
    expect(applySpy).toHaveBeenCalled();
    expect(result.transcript).toContain('Deliberation Pass');
    expect(result.costUsd).toBeGreaterThan(0.05);

    needsSpy.mockRestore();
    applySpy.mockRestore();
    querySpy.mockRestore();
  });

  it('should skip deliberation when needsDeliberation returns false', async () => {
    const needsSpy = vi.spyOn(deliberationModule, 'needsDeliberation').mockReturnValue(false);
    const querySpy = vi.spyOn(axisEvaluatorModule, 'runSingleTurnQuery');

    const deliberationConfig = ConfigSchema.parse({ llm: { deliberation: true } });
    const opts = makeOptions({ config: deliberationConfig, deliberation: true });
    const result = await evaluateFile(opts);

    expect(needsSpy).toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
    expect(result.transcript).toContain('Deliberation Pass — SKIPPED');

    needsSpy.mockRestore();
    querySpy.mockRestore();
  });

  it('should handle deliberation failure gracefully', async () => {
    const needsSpy = vi.spyOn(deliberationModule, 'needsDeliberation').mockReturnValue(true);
    const querySpy = vi.spyOn(axisEvaluatorModule, 'runSingleTurnQuery').mockRejectedValue(new Error('Opus timeout'));

    const deliberationConfig = ConfigSchema.parse({ llm: { deliberation: true } });
    const opts = makeOptions({ config: deliberationConfig, deliberation: true });
    const result = await evaluateFile(opts);

    // Should still return a valid review (the pre-deliberation one)
    expect(result.review.version).toBe(2);
    expect(result.transcript).toContain('Deliberation Pass — FAILED');
    expect(result.transcript).toContain('Opus timeout');

    needsSpy.mockRestore();
    querySpy.mockRestore();
  });
});
