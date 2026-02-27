import { describe, it, expect } from 'vitest';
import { buildTestsSystemPrompt, buildTestsUserMessage } from './tests.js';
import type { AxisContext } from '../axis-evaluator.js';
import type { Task } from '../../schemas/task.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

const mockTask: Task = {
  version: 1,
  file: 'src/core/cache.ts',
  hash: 'ghi789',
  symbols: [
    { name: 'getCacheEntry', kind: 'function', exported: true, line_start: 1, line_end: 15 },
    { name: 'CacheEntry', kind: 'type', exported: true, line_start: 17, line_end: 22 },
  ],
  scanned_at: '2026-02-25T00:00:00Z',
};

const mockTaskWithCoverage: Task = {
  ...mockTask,
  coverage: {
    statements_total: 20,
    statements_covered: 18,
    branches_total: 6,
    branches_covered: 4,
    functions_total: 5,
    functions_covered: 5,
    lines_total: 20,
    lines_covered: 18,
  },
};

const mockConfig: Config = ConfigSchema.parse({});

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task: mockTask,
    fileContent: 'export function getCacheEntry(key: string): CacheEntry | null {\n  return cache.get(key) ?? null;\n}\n\nexport type CacheEntry = { key: string; value: unknown; ttl: number };\n',
    config: mockConfig,
    projectRoot: '/tmp/test',
    ...overrides,
  };
}

describe('buildTestsSystemPrompt', () => {
  it('should produce a focused prompt mentioning only tests', () => {
    const prompt = buildTestsSystemPrompt();
    expect(prompt).toContain('tests');
    expect(prompt).toContain('GOOD');
    expect(prompt).toContain('WEAK');
    expect(prompt).toContain('NONE');
    expect(prompt).not.toContain('correction');
    expect(prompt).not.toContain('utility');
    expect(prompt.split('\n').length).toBeLessThan(50);
  });
});

describe('buildTestsUserMessage', () => {
  it('should include file content and symbols', () => {
    const msg = buildTestsUserMessage(createCtx());
    expect(msg).toContain('src/core/cache.ts');
    expect(msg).toContain('getCacheEntry');
    expect(msg).toContain('CacheEntry');
  });

  it('should include coverage data when present', () => {
    const msg = buildTestsUserMessage(createCtx({ task: mockTaskWithCoverage }));
    expect(msg).toContain('Coverage Data');
    expect(msg).toContain('Statements');
    expect(msg).toContain('90.0%');
    expect(msg).toContain('Functions');
    expect(msg).toContain('100.0%');
  });

  it('should work without coverage data', () => {
    const msg = buildTestsUserMessage(createCtx());
    expect(msg).not.toContain('Coverage Data');
    expect(msg).toContain('getCacheEntry');
  });
});
