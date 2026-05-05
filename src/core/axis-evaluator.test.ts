// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { resolveAxisModel, resolveCodeSummaryModel, resolveDeliberationModel, resolveAgentModel, buildProviderStats, getCodeFenceTag, getLanguageLines, composeAxisSystemPrompt } from './axis-evaluator.js';
import type { AxisTiming } from './file-evaluator.js';
import type { AxisEvaluator, AxisContext, AxisResult } from './axis-evaluator.js';
import type { Config } from '../schemas/config.js';
import { ConfigSchema } from '../schemas/config.js';
import type { Task } from '../schemas/task.js';
import { buildBestPracticesUserMessage } from './axes/best-practices.js';
import { buildDocumentationUserMessage } from './axes/documentation.js';
import { buildCorrectionUserMessage } from './axes/correction.js';
import { buildUtilityUserMessage, UtilityResponseSchema } from './axes/utility.js';
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
    const config = makeConfig({ models: { fast: 'provider/fast-model' } });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('provider/fast-model');
  });

  it('should use models.quality for sonnet evaluators when no axis override', () => {
    const config = makeConfig({ models: { quality: 'provider/quality-model' } });
    const evaluator = makeEvaluator('sonnet');
    expect(resolveAxisModel(evaluator, config)).toBe('provider/quality-model');
  });

  it('should fall back to models.fast default for haiku evaluators', () => {
    const config = makeConfig();
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe(config.models.fast);
  });

  it('should prefer axis model over models.fast and models.quality', () => {
    const config = makeConfig({
      models: { quality: 'provider/quality', fast: 'provider/fast' },
      axes: { utility: { model: 'provider/override' } },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('provider/override');
  });

  it('should use axis model when its provider is configured', () => {
    const config = makeConfig({
      providers: { google: { mode: 'subscription' } },
      axes: { utility: { model: 'google/gemini-2.5-flash' } },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('google/gemini-2.5-flash');
  });

  it('should fall through google axis model when Google provider is absent', () => {
    const config = makeConfig({
      axes: { utility: { model: 'google/gemini-2.5-flash' } },
    });
    const evaluator = makeEvaluator('haiku');
    // No providers.google → fall through to default
    expect(resolveAxisModel(evaluator, config)).toBe(config.models.fast);
  });

  it('should return models.quality for sonnet evaluators with no override', () => {
    const config = makeConfig({
      models: { quality: 'provider/quality-model' },
      axes: { correction: {} },
    });
    const evaluator = makeEvaluator('sonnet', { id: 'correction' });
    expect(resolveAxisModel(evaluator, config)).toBe('provider/quality-model');
  });
});

// ---------------------------------------------------------------------------
// Story 42.3: resolveCodeSummaryModel (replaces resolveNlpModel)
// ---------------------------------------------------------------------------

describe('resolveCodeSummaryModel', () => {
  it('returns models.code_summary when defined', () => {
    const config = makeConfig({
      models: { code_summary: 'google/gemini-2.5-flash' },
    });
    expect(resolveCodeSummaryModel(config)).toBe('google/gemini-2.5-flash');
  });

  it('falls back to models.fast when code_summary is undefined', () => {
    const config = makeConfig();
    expect(resolveCodeSummaryModel(config)).toBe(config.models.fast);
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
      models: { deliberation: 'provider/delib-model' },
    });
    expect(resolveDeliberationModel(config)).toBe('provider/delib-model');
  });

  it('uses default models.deliberation', () => {
    const config = makeConfig();
    expect(resolveDeliberationModel(config)).toBe(config.models.deliberation);
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
      models: { quality: 'provider/quality-model' },
    });
    expect(resolveAgentModel('scaffolding', config)).toBe('provider/quality-model');
  });

  it('falls back to models.quality when agents.review is undefined', () => {
    const config = makeConfig();
    expect(resolveAgentModel('review', config)).toBe(config.models.quality);
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

// ---------------------------------------------------------------------------
// Story 44.2 — composeAxisSystemPrompt with user instructions
// ---------------------------------------------------------------------------

describe('composeAxisSystemPrompt — user instructions injection', () => {
  const AXIS_PROMPT = 'You are the correction evaluator.';

  it('does not inject calibration block when userInstructions is undefined', () => {
    const result = composeAxisSystemPrompt(AXIS_PROMPT, undefined, undefined);
    expect(result).not.toContain('## User Calibration');
  });

  it('injects calibration block between axis prompt and schema', () => {
    const result = composeAxisSystemPrompt(AXIS_PROMPT, undefined, 'Prefer const over let.');
    expect(result).toContain('## User Calibration');
    expect(result).toContain('Prefer const over let.');
  });

  it('calibration block appears after axis prompt', () => {
    const result = composeAxisSystemPrompt(AXIS_PROMPT, undefined, 'Custom rule.');
    const axisIdx = result.indexOf(AXIS_PROMPT);
    const calibIdx = result.indexOf('## User Calibration');
    expect(axisIdx).toBeLessThan(calibIdx);
  });

  it('calibration block appears before schema when schema is provided', () => {
    const result = composeAxisSystemPrompt(AXIS_PROMPT, UtilityResponseSchema, 'Custom rule.');
    const calibIdx = result.indexOf('## User Calibration');
    const schemaIdx = result.indexOf('## Expected output schema');
    expect(calibIdx).toBeGreaterThan(-1);
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(calibIdx).toBeLessThan(schemaIdx);
  });

  it('does not inject calibration block when userInstructions is empty string', () => {
    const result = composeAxisSystemPrompt(AXIS_PROMPT, undefined, '');
    expect(result).not.toContain('## User Calibration');
  });
});

// ---------------------------------------------------------------------------
// v3 path — exercised when the config came from a `version: 3` YAML
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../utils/config-loader.js';

describe('axis resolvers — v3 path', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-axis-resolvers-v3-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function loadV3(yml: string): ReturnType<typeof loadConfig> {
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    return loadConfig(tempDir);
  }

  const baseV3 = `
version: 3
providers:
  anthropic:
    transport: claude_agent_sdk
    auth: oauth
    models:
      - claude-sonnet-4-6
      - claude-haiku-4-5-20251001
      - claude-opus-4-6
  google:
    transport: google_genai
    auth: api_key
    env_key: GEMINI_API_KEY
    models:
      - gemini-2.5-flash-lite
      - gemini-2.5-pro
  'local-lite':
    transport: onnxruntime_node
    models:
      - jinaai/jina-embeddings-v2-base-code
      - Xenova/all-MiniLM-L6-v2
routing:
  generation:
    quality: anthropic/claude-sonnet-4-6
    fast: anthropic/claude-haiku-4-5-20251001
    deliberation: anthropic/claude-opus-4-6
    summarization: google/gemini-2.5-flash-lite
  embeddings:
    code: local-lite/jinaai/jina-embeddings-v2-base-code
    text: local-lite/Xenova/all-MiniLM-L6-v2
`;

  describe('resolveAxisModel', () => {
    it('returns routing.generation.fast for haiku-tier evaluators', () => {
      const config = loadV3(baseV3);
      const evaluator = { id: 'utility', defaultModel: 'haiku' } as AxisEvaluator;
      expect(resolveAxisModel(evaluator, config)).toBe('anthropic/claude-haiku-4-5-20251001');
    });

    it('returns routing.generation.quality for non-haiku evaluators', () => {
      const config = loadV3(baseV3);
      const evaluator = { id: 'correction', defaultModel: 'sonnet' } as AxisEvaluator;
      expect(resolveAxisModel(evaluator, config)).toBe('anthropic/claude-sonnet-4-6');
    });

    it('honours per-axis override declared in evaluation.axes.<id>.model', () => {
      const config = loadV3(`${baseV3.trimEnd()}
evaluation:
  axes:
    correction:
      enabled: true
      model: anthropic/claude-opus-4-6
`);
      const evaluator = { id: 'correction', defaultModel: 'sonnet' } as AxisEvaluator;
      expect(resolveAxisModel(evaluator, config)).toBe('anthropic/claude-opus-4-6');
    });

    it('falls through to routing default when override points at undeclared provider', () => {
      // Schema validation would reject an undeclared override at parse time,
      // so we mutate the in-memory v3 source post-load to test the resolver's
      // safety net (defense in depth — a downstream tool could also reach in).
      const config = loadV3(baseV3);
      const sym = Symbol.for('anatoly.config.v3Source');
      const v3 = (config as unknown as Record<symbol, { evaluation: { axes: Record<string, unknown> } }>)[sym];
      v3.evaluation.axes.utility = { enabled: true, model: 'ghost/gemini-2.5-flash' };
      const evaluator = { id: 'utility', defaultModel: 'haiku' } as AxisEvaluator;
      expect(resolveAxisModel(evaluator, config)).toBe('anthropic/claude-haiku-4-5-20251001');
    });
  });

  describe('resolveCodeSummaryModel', () => {
    it('returns routing.generation.summarization', () => {
      const config = loadV3(baseV3);
      expect(resolveCodeSummaryModel(config)).toBe('google/gemini-2.5-flash-lite');
    });
  });

  describe('resolveDeliberationModel', () => {
    it('returns routing.generation.deliberation', () => {
      const config = loadV3(baseV3);
      expect(resolveDeliberationModel(config)).toBe('anthropic/claude-opus-4-6');
    });
  });

  describe('resolveAgentModel', () => {
    it('returns routing.generation.quality for any phase (no per-phase split in v3)', () => {
      const config = loadV3(baseV3);
      expect(resolveAgentModel('scaffolding', config)).toBe('anthropic/claude-sonnet-4-6');
      expect(resolveAgentModel('review', config)).toBe('anthropic/claude-sonnet-4-6');
    });
  });
});
