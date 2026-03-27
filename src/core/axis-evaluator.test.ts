// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { resolveAxisModel, getCodeFenceTag, getLanguageLines, resolveSemaphore } from './axis-evaluator.js';
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

function makeEvaluator(defaultModel: 'sonnet' | 'haiku'): AxisEvaluator {
  return {
    id: 'utility',
    defaultModel,
    evaluate: async (_ctx: AxisContext, _abort: AbortController): Promise<AxisResult> => {
      throw new Error('not implemented');
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveAxisModel', () => {
  it('should use config axis model override when specified', () => {
    const config = makeConfig({
      llm: { axes: { utility: { enabled: true, model: 'custom-model-123' } } },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('custom-model-123');
  });

  it('should use fast_model for haiku evaluators when no axis override', () => {
    const config = makeConfig({
      llm: { fast_model: 'claude-haiku-4-5-20251001' },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('claude-haiku-4-5-20251001');
  });

  it('should use main model for sonnet evaluators when no axis override', () => {
    const config = makeConfig({
      llm: { model: 'claude-sonnet-4-6' },
    });
    const evaluator = makeEvaluator('sonnet');
    expect(resolveAxisModel(evaluator, config)).toBe('claude-sonnet-4-6');
  });

  it('should fall back to index_model when fast_model is not set for haiku evaluators', () => {
    const config = makeConfig();
    const evaluator = makeEvaluator('haiku');
    // fast_model is optional, should fall back to index_model
    expect(resolveAxisModel(evaluator, config)).toBe('claude-haiku-4-5-20251001');
  });

  it('should prefer axis model over fast_model and main model', () => {
    const config = makeConfig({
      llm: {
        model: 'claude-sonnet-4-6',
        fast_model: 'claude-haiku-4-5-20251001',
        axes: { utility: { model: 'override-model' } },
      },
    });
    const evaluator = makeEvaluator('haiku');
    expect(resolveAxisModel(evaluator, config)).toBe('override-model');
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
    expect(resolveSemaphore('gemini-3-flash-preview', claude, gemini)).toBe(gemini);
  });

  it('returns Claude semaphore when Gemini semaphore is undefined', () => {
    const claude = new Semaphore(24);
    expect(resolveSemaphore('gemini-3-flash-preview', claude, undefined)).toBe(claude);
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
