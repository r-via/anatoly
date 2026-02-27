import { describe, it, expect } from 'vitest';
import { buildDuplicationSystemPrompt, buildDuplicationUserMessage } from './duplication.js';
import type { AxisContext } from '../axis-evaluator.js';
import type { Task } from '../../schemas/task.js';
import type { Config } from '../../schemas/config.js';
import type { PreResolvedRag } from '../axis-evaluator.js';
import { ConfigSchema } from '../../schemas/config.js';

const mockTask: Task = {
  version: 1,
  file: 'src/utils/math.ts',
  hash: 'def456',
  symbols: [
    { name: 'calculateTotal', kind: 'function', exported: true, line_start: 1, line_end: 15 },
    { name: 'roundPrice', kind: 'function', exported: true, line_start: 17, line_end: 25 },
  ],
  scanned_at: '2026-02-25T00:00:00Z',
};

const mockConfig: Config = ConfigSchema.parse({});

const mockRag: PreResolvedRag = [
  {
    symbolName: 'calculateTotal',
    lineStart: 1,
    lineEnd: 15,
    results: [
      {
        card: {
          id: 'src/other/pricing.ts::1::20',
          filePath: 'src/other/pricing.ts',
          name: 'computeSum',
          signature: '(items: Item[]) => number',
          summary: 'Computes the total sum of item prices',
          keyConcepts: ['pricing', 'sum'],
          behavioralProfile: 'pure',
          complexityScore: 2,
          calledInternals: [],
          lastIndexed: '2026-02-25T00:00:00Z',
        },
        score: 0.92,
      },
    ],
  },
  {
    symbolName: 'roundPrice',
    lineStart: 17,
    lineEnd: 25,
    results: [],
  },
];

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task: mockTask,
    fileContent: 'export function calculateTotal(items) {\n  return items.reduce((a, b) => a + b.price, 0);\n}\n\nexport function roundPrice(p) {\n  return Math.round(p * 100) / 100;\n}\n',
    config: mockConfig,
    projectRoot: '/tmp/test',
    preResolvedRag: mockRag,
    ...overrides,
  };
}

describe('buildDuplicationSystemPrompt', () => {
  it('should produce a focused prompt mentioning only duplication', () => {
    const prompt = buildDuplicationSystemPrompt();
    expect(prompt).toContain('duplication');
    expect(prompt).toContain('UNIQUE');
    expect(prompt).toContain('DUPLICATE');
    expect(prompt).toContain('duplicate_target');
    expect(prompt).not.toContain('correction');
    expect(prompt).not.toContain('utility');
    expect(prompt.split('\n').length).toBeLessThan(50);
  });
});

describe('buildDuplicationUserMessage', () => {
  it('should include file content and symbols', () => {
    const msg = buildDuplicationUserMessage(createCtx());
    expect(msg).toContain('src/utils/math.ts');
    expect(msg).toContain('calculateTotal');
    expect(msg).toContain('roundPrice');
  });

  it('should include RAG similarity results', () => {
    const msg = buildDuplicationUserMessage(createCtx());
    expect(msg).toContain('RAG — Semantic Duplication');
    expect(msg).toContain('computeSum');
    expect(msg).toContain('src/other/pricing.ts');
    expect(msg).toContain('0.920');
  });

  it('should indicate when no similar functions found', () => {
    const msg = buildDuplicationUserMessage(createCtx());
    expect(msg).toContain('No similar functions found. Mark UNIQUE.');
  });

  it('should handle missing RAG data', () => {
    const msg = buildDuplicationUserMessage(createCtx({ preResolvedRag: undefined }));
    expect(msg).toContain('No RAG data available');
    expect(msg).toContain('Mark all symbols as UNIQUE');
  });

  it('should handle empty RAG array', () => {
    const msg = buildDuplicationUserMessage(createCtx({ preResolvedRag: [] }));
    expect(msg).toContain('No RAG data available');
  });

  it('should handle null results (function not indexed)', () => {
    const ragWithNull: PreResolvedRag = [
      { symbolName: 'calculateTotal', lineStart: 1, lineEnd: 15, results: null },
    ];
    const msg = buildDuplicationUserMessage(createCtx({ preResolvedRag: ragWithNull }));
    expect(msg).toContain('Function not indexed');
    expect(msg).toContain('Mark UNIQUE');
  });
});
