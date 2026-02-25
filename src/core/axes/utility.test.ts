import { describe, it, expect } from 'vitest';
import { buildUtilitySystemPrompt, buildUtilityUserMessage } from './utility.js';
import type { AxisContext } from '../axis-evaluator.js';
import type { Task } from '../../schemas/task.js';
import type { UsageGraph } from '../usage-graph.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

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

const mockConfig: Config = ConfigSchema.parse({});

const mockUsageGraph: UsageGraph = {
  usages: new Map([
    ['formatNumber::src/utils/format.ts', new Set(['src/core/reporter.ts', 'src/commands/status.ts'])],
    // MAX_WIDTH has 0 importers → DEAD
  ]),
  typeOnlyUsages: new Map(),
};

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task: mockTask,
    fileContent: 'export function formatNumber(n: number): string {\n  return padLeft(n.toString());\n}\n\nfunction padLeft(s: string): string {\n  return s.padStart(10);\n}\n\nexport const MAX_WIDTH = 80;\n',
    config: mockConfig,
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

  it('should work without usage graph', () => {
    const msg = buildUtilityUserMessage(createCtx({ usageGraph: undefined }));
    expect(msg).not.toContain('Pre-computed Import Analysis');
    expect(msg).toContain('formatNumber');
  });
});
