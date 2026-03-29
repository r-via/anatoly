// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { resolveAxisModel, resolveCodeSummaryModel, resolveDeliberationModel, resolveAgentModel, buildProviderStats, getCodeFenceTag, getLanguageLines, resolveSemaphore } from './axis-evaluator.js';
import type { AxisTiming } from './file-evaluator.js';
import type { AxisEvaluator, AxisContext, AxisResult } from './axis-evaluator.js';
import type { Config } from '../schemas/config.js';
import { ConfigSchema } from '../schemas/config.js';
import type { Task } from '../schemas/task.js';
import { Semaphore } from './sdk-semaphore.js';
import { buildBestPracticesUserMessage } from './axes/best-practices.js';
import { buildDocumentationUserMessage } from './axes/documentation.js';
import { buildCorrectionUserMessage } from './axes/correction.js';
import { buildUtilityUserMessage } from './axes/utility.js';
import { buildDuplicationUserMessage } from './axes/duplication.js';
import { buildOverengineeringUserMessage } from './axes/overengineering.js';
import { buildTestsUserMessage } from './axes/tests.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

function makeEvaluator(defaultModel: 'sonnet' | 'haiku', opts?: { id?: string }): AxisEvaluator {
  return {
    id: (opts?.id ?? 'utility') as AxisEvaluator['id'],
    defaultModel,
    evaluate: async (_ctx: AxisContext, _abort: AbortController): Promise<AxisResult> => {
      throw new Error('not implemented');
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — Story 42.3: resolveAxisModel (v1.0 config paths)
// ---------------------------------------------------------------------------

describe('resolveAxisModel', () => {
  it('should use config.axes.[id].model override when specified', () => {
    const config = makeConfig({
      axes: { utility: { enabled: true, model: 'custom-model-123' } },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('custom-model-123');
  });

  it('should use models.fast for haiku evaluators when no axis override', () => {
    const config = makeConfig({
      models: { fast: 'claude-haiku-4-5-20251001' },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('claude-haiku-4-5-20251001');
  });

  it('should use models.quality for sonnet evaluators when no axis override', () => {
    const config = makeConfig({
      models: { quality: 'claude-sonnet-4-6' },
    });
    const evaluator = makeEvaluator('sonnet');
    expect(resolveAxisModel(evaluator, config)).toBe('claude-sonnet-4-6');
  });

  it('should fall back to models.fast when no override for haiku evaluators', () => {
    const config = makeConfig();
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('claude-haiku-4-5-20251001');
  });

  it('should prefer axis model over models.fast and models.quality', () => {
    const config = makeConfig({
      models: { quality: 'claude-sonnet-4-6', fast: 'claude-haiku-4-5-20251001' },
      axes: { utility: { model: 'override-model' } },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('override-model');
  });

  it('should route to Gemini when axis model is set to gemini-* and Google provider exists', () => {
    const config = makeConfig({
      providers: { google: { mode: 'subscription' } },
      axes: { utility: { model: 'gemini-2.5-flash' } },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('gemini-2.5-flash');
  });

  it('should fall through gemini-* axis model when Google provider is absent', () => {
    const config = makeConfig({
      axes: { utility: { model: 'gemini-2.5-flash' } },
    });
    const evaluator = makeEvaluator('haiku');
    // No providers.google → fall through to default
    expect(resolveAxisModel(evaluator, config)).toBe('claude-haiku-4-5-20251001');
  });

  it('should return models.quality for sonnet evaluators with no override and no Gemini', () => {
    const config = makeConfig({
      models: { quality: 'claude-sonnet-4-6' },
    });
    const evaluator = makeEvaluator('sonnet', { id: 'correction' });
    expect(resolveAxisModel(evaluator, config)).toBe('claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// Story 42.3: resolveCodeSummaryModel (replaces resolveNlpModel)
// ---------------------------------------------------------------------------

describe('resolveCodeSummaryModel', () => {
  it('returns models.code_summary when defined', () => {
    const config = makeConfig({
      models: { code_summary: 'gemini-2.5-flash' },
    });
    expect(resolveCodeSummaryModel(config)).toBe('gemini-2.5-flash');
  });

  it('falls back to models.fast when code_summary is undefined', () => {
    const config = makeConfig();
    expect(resolveCodeSummaryModel(config)).toBe('claude-haiku-4-5-20251001');
  });

  it('uses custom fast model as fallback', () => {
    const config = makeConfig({
      models: { fast: 'custom-fast-model' },
    });
    expect(resolveCodeSummaryModel(config)).toBe('custom-fast-model');
  });
});

// ---------------------------------------------------------------------------
// Story 42.3: resolveDeliberationModel (v1.0 paths)
// ---------------------------------------------------------------------------

describe('resolveDeliberationModel', () => {
  it('returns agents.deliberation when defined', () => {
    const config = makeConfig({
      agents: { deliberation: 'custom-delib-model' },
    });
    expect(resolveDeliberationModel(config)).toBe('custom-delib-model');
  });

  it('falls back to models.deliberation when agents.deliberation is undefined', () => {
    const config = makeConfig({
      models: { deliberation: 'claude-opus-4-6' },
    });
    expect(resolveDeliberationModel(config)).toBe('claude-opus-4-6');
  });

  it('uses default models.deliberation', () => {
    const config = makeConfig();
    expect(resolveDeliberationModel(config)).toBe('claude-opus-4-6');
  });
});

// ---------------------------------------------------------------------------
// Story 42.3: resolveAgentModel (new)
// ---------------------------------------------------------------------------

describe('resolveAgentModel', () => {
  it('returns agents.scaffolding when defined for scaffolding phase', () => {
    const config = makeConfig({
      agents: { scaffolding: 'custom-scaffolding-model' },
    });
    expect(resolveAgentModel('scaffolding', config)).toBe('custom-scaffolding-model');
  });

  it('returns agents.review when defined for review phase', () => {
    const config = makeConfig({
      agents: { review: 'custom-review-model' },
    });
    expect(resolveAgentModel('review', config)).toBe('custom-review-model');
  });

  it('falls back to models.quality when agents.scaffolding is undefined', () => {
    const config = makeConfig({
      models: { quality: 'claude-sonnet-4-6' },
    });
    expect(resolveAgentModel('scaffolding', config)).toBe('claude-sonnet-4-6');
  });

  it('falls back to models.quality when agents.review is undefined', () => {
    const config = makeConfig();
    expect(resolveAgentModel('review', config)).toBe('claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// Task / AxisContext helpers for language injection tests
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    version: 1,
    file: overrides.file ?? 'src/main.ts',
    hash: 'abc123',
    symbols: overrides.symbols ?? [],
    scanned_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(taskOverrides: Partial<Task> = {}): AxisContext {
  return {
    task: makeTask(taskOverrides),
    fileContent: taskOverrides.language === 'bash' ? '#!/bin/bash\necho hello' : 'export const x = 1;',
    config: makeConfig(),
    projectRoot: '/tmp',
  };
}

// ---------------------------------------------------------------------------
// AC 31.19: getCodeFenceTag
// ---------------------------------------------------------------------------

describe('getCodeFenceTag', () => {
  it('returns "typescript" by default when no language set', () => {
    expect(getCodeFenceTag(makeTask())).toBe('typescript');
  });

  it('returns "bash" for bash language', () => {
    expect(getCodeFenceTag(makeTask({ language: 'bash' }))).toBe('bash');
  });

  it('returns "python" for python language', () => {
    expect(getCodeFenceTag(makeTask({ language: 'python' }))).toBe('python');
  });

  it('returns "rust" for rust language', () => {
    expect(getCodeFenceTag(makeTask({ language: 'rust' }))).toBe('rust');
  });

  it('returns "go" for go language', () => {
    expect(getCodeFenceTag(makeTask({ language: 'go' }))).toBe('go');
  });

  it('returns "typescript" explicitly for typescript language', () => {
    expect(getCodeFenceTag(makeTask({ language: 'typescript' }))).toBe('typescript');
  });
});

// ---------------------------------------------------------------------------
// AC 31.19: getLanguageLines
// ---------------------------------------------------------------------------

describe('getLanguageLines', () => {
  it('returns empty array when no language set (zero regression)', () => {
    expect(getLanguageLines(makeTask())).toEqual([]);
  });

  it('returns empty array for typescript with no framework (zero regression)', () => {
    expect(getLanguageLines(makeTask({ language: 'typescript' }))).toEqual([]);
  });

  it('returns Language header for bash', () => {
    const lines = getLanguageLines(makeTask({ language: 'bash' }));
    expect(lines).toContain('## Language: bash');
    expect(lines).not.toContainEqual(expect.stringMatching(/Framework/));
  });

  it('returns Language header for rust', () => {
    const lines = getLanguageLines(makeTask({ language: 'rust' }));
    expect(lines).toContain('## Language: rust');
  });

  it('returns Language + Framework headers for python + django', () => {
    const lines = getLanguageLines(makeTask({ language: 'python', framework: 'django' }));
    expect(lines).toContain('## Language: python');
    expect(lines).toContain('## Framework: django');
  });

  it('returns Language + Framework for typescript + react', () => {
    const lines = getLanguageLines(makeTask({ language: 'typescript', framework: 'react' }));
    expect(lines).toContain('## Language: typescript');
    expect(lines).toContain('## Framework: react');
  });
});

// ---------------------------------------------------------------------------
// AC 31.19: All 7 axes inject Language/Framework + dynamic fence
// ---------------------------------------------------------------------------

const AXIS_BUILDERS = [
  { name: 'best-practices', fn: buildBestPracticesUserMessage },
  { name: 'documentation', fn: buildDocumentationUserMessage },
  { name: 'correction', fn: buildCorrectionUserMessage },
  { name: 'utility', fn: buildUtilityUserMessage },
  { name: 'duplication', fn: buildDuplicationUserMessage },
  { name: 'overengineering', fn: buildOverengineeringUserMessage },
  { name: 'tests', fn: buildTestsUserMessage },
] as const;

describe('All 7 axes: language/framework injection', () => {
  for (const { name, fn } of AXIS_BUILDERS) {
    describe(name, () => {
      it('AC 31.19: .sh → ## Language: bash + ```bash fence', () => {
        const msg = fn(makeCtx({ file: 'deploy.sh', language: 'bash' }));
        expect(msg).toContain('## Language: bash');
        expect(msg).toContain('```bash');
        expect(msg).not.toContain('```typescript');
      });

      it('AC 31.19: .py + django → ## Language: python + ## Framework: django', () => {
        const msg = fn(makeCtx({ file: 'views.py', language: 'python', framework: 'django' }));
        expect(msg).toContain('## Language: python');
        expect(msg).toContain('## Framework: django');
        expect(msg).toContain('```python');
      });

      it('AC 31.19: .rs → ## Language: rust + ```rust fence', () => {
        const msg = fn(makeCtx({ file: 'lib.rs', language: 'rust' }));
        expect(msg).toContain('## Language: rust');
        expect(msg).toContain('```rust');
      });

      it('AC 31.19: TypeScript no framework → identical (no Language/Framework headers)', () => {
        const msg = fn(makeCtx());
        expect(msg).not.toContain('## Language:');
        expect(msg).not.toContain('## Framework:');
        expect(msg).toContain('```typescript');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Story 2.2: resolveSemaphore — dual semaphore routing
// ---------------------------------------------------------------------------

describe('resolveSemaphore', () => {
  it('returns Claude semaphore for Claude models', () => {
    const claude = new Semaphore(24);
    const gemini = new Semaphore(12);
    expect(resolveSemaphore('claude-sonnet-4-6', claude, gemini)).toBe(claude);
  });

  it('returns Gemini semaphore for gemini- prefixed models', () => {
    const claude = new Semaphore(24);
    const gemini = new Semaphore(12);
    expect(resolveSemaphore('gemini-2.5-flash', claude, gemini)).toBe(gemini);
  });

  it('returns Claude semaphore when Gemini semaphore is undefined', () => {
    const claude = new Semaphore(24);
    expect(resolveSemaphore('gemini-2.5-flash', claude, undefined)).toBe(claude);
  });

  it('returns undefined when both are undefined', () => {
    expect(resolveSemaphore('claude-sonnet-4-6', undefined, undefined)).toBeUndefined();
  });

  it('returns Claude semaphore for haiku models', () => {
    const claude = new Semaphore(24);
    const gemini = new Semaphore(12);
    expect(resolveSemaphore('claude-haiku-4-5-20251001', claude, gemini)).toBe(claude);
  });

  it('returns Gemini semaphore for gemini-2.5-flash', () => {
    const claude = new Semaphore(24);
    const gemini = new Semaphore(12);
    expect(resolveSemaphore('gemini-2.5-flash', claude, gemini)).toBe(gemini);
  });
});

// ---------------------------------------------------------------------------
// Story 39.2: buildProviderStats — provider breakdown for run-metrics
// ---------------------------------------------------------------------------

function makeTiming(axisId: string, provider: 'anthropic' | 'gemini', costUsd = 0.05): AxisTiming {
  return {
    axisId: axisId as AxisTiming['axisId'],
    provider,
    costUsd,
    durationMs: 100,
    inputTokens: 500,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

describe('buildProviderStats', () => {
  it('AC 39.2.1: returns providers object with anthropic and gemini breakdowns', () => {
    const timings: AxisTiming[] = [
      makeTiming('utility', 'gemini', 0),
      makeTiming('duplication', 'gemini', 0),
      makeTiming('correction', 'anthropic', 0.10),
      makeTiming('best_practices', 'anthropic', 0.12),
    ];
    const stats = buildProviderStats(timings);
    expect(stats.providers.anthropic).toEqual({ calls: 2, costUsd: 0.22 });
    expect(stats.providers.gemini).toEqual({ calls: 2, costUsd: 0 });
  });

  it('AC 39.2.1: computes claude_quota_saved_pct', () => {
    const timings: AxisTiming[] = [
      makeTiming('utility', 'gemini', 0),
      makeTiming('duplication', 'gemini', 0),
      makeTiming('overengineering', 'gemini', 0),
      makeTiming('correction', 'anthropic', 0.10),
    ];
    const stats = buildProviderStats(timings);
    // 3 out of 4 calls routed to Gemini = 75%
    expect(stats.claude_quota_saved_pct).toBe(75);
  });

  it('returns 0% quota saved when no Gemini calls', () => {
    const timings: AxisTiming[] = [
      makeTiming('correction', 'anthropic', 0.10),
      makeTiming('best_practices', 'anthropic', 0.12),
    ];
    const stats = buildProviderStats(timings);
    expect(stats.claude_quota_saved_pct).toBe(0);
    expect(stats.providers.gemini).toEqual({ calls: 0, costUsd: 0 });
  });

  it('handles empty timings', () => {
    const stats = buildProviderStats([]);
    expect(stats.claude_quota_saved_pct).toBe(0);
    expect(stats.providers.anthropic).toEqual({ calls: 0, costUsd: 0 });
    expect(stats.providers.gemini).toEqual({ calls: 0, costUsd: 0 });
  });
});

// ---------------------------------------------------------------------------
// Story 42.3: AxisEvaluator interface no longer has defaultGeminiMode
// ---------------------------------------------------------------------------

describe('AxisEvaluator interface', () => {
  it('should not require defaultGeminiMode', () => {
    const evaluator: AxisEvaluator = {
      id: 'utility',
      defaultModel: 'haiku',
      evaluate: async () => { throw new Error('not implemented'); },
    };
    // Should compile and work without defaultGeminiMode
    expect(evaluator.id).toBe('utility');
    expect(evaluator.defaultModel).toBe('haiku');
    expect((evaluator as unknown as Record<string, unknown>).defaultGeminiMode).toBeUndefined();
  });
});
