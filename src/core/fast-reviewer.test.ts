import { describe, it, expect } from 'vitest';
import { buildFastSystemPrompt, buildFastUserMessage } from './fast-reviewer.js';
import type { Task } from '../schemas/task.js';
import type { PromptOptions } from '../utils/prompt-builder.js';
import type { UsageGraph } from './usage-graph.js';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  version: 1,
  file: 'src/utils/helpers.ts',
  hash: 'abc123',
  symbols: [
    { name: 'add', kind: 'function', exported: true, line_start: 1, line_end: 3 },
    { name: 'internal', kind: 'function', exported: false, line_start: 5, line_end: 8 },
  ],
  scanned_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const sampleContent = `export function add(a: number, b: number): number {
  return a + b;
}

function internal(): void {
  // internal helper
  console.log('hello');
}
`;

describe('buildFastSystemPrompt', () => {
  it('should not mention tools or Grep', () => {
    const prompt = buildFastSystemPrompt(makeTask());
    expect(prompt).not.toContain('Grep');
    expect(prompt).not.toContain('Read');
    expect(prompt).not.toContain('Glob');
    expect(prompt).toContain('do NOT have access to any tools');
  });

  it('should include the file name', () => {
    const prompt = buildFastSystemPrompt(makeTask({ file: 'src/core/magic.ts' }));
    expect(prompt).toContain('src/core/magic.ts');
  });

  it('should instruct output ONLY the JSON', () => {
    const prompt = buildFastSystemPrompt(makeTask());
    expect(prompt).toContain('Output ONLY the JSON');
    expect(prompt).toContain('All context is provided');
  });

  it('should include utility rule based on usage graph', () => {
    const prompt = buildFastSystemPrompt(makeTask());
    expect(prompt).toContain('Pre-computed Import Analysis');
    expect(prompt).toContain('0 importers');
  });

  it('should include duplication rule based on RAG', () => {
    const prompt = buildFastSystemPrompt(makeTask());
    expect(prompt).toContain('RAG Similarity');
    expect(prompt).toContain('Score >= 0.85');
  });

  it('should include guardrails', () => {
    const prompt = buildFastSystemPrompt(makeTask());
    expect(prompt).toContain('Guardrails');
    expect(prompt).toContain('CLEAN');
    expect(prompt).toContain('NEEDS_REFACTOR');
    expect(prompt).toContain('CRITICAL');
  });
});

describe('buildFastUserMessage', () => {
  it('should include file content inline', () => {
    const msg = buildFastUserMessage(makeTask(), sampleContent);
    expect(msg).toContain('```typescript');
    expect(msg).toContain('export function add');
    expect(msg).toContain('function internal');
  });

  it('should list all symbols', () => {
    const msg = buildFastUserMessage(makeTask(), sampleContent);
    expect(msg).toContain('export function add (L1–L3)');
    expect(msg).toContain('function internal (L5–L8)');
  });

  it('should include coverage when present', () => {
    const task = makeTask({
      coverage: {
        statements_total: 10, statements_covered: 8,
        branches_total: 4, branches_covered: 3,
        functions_total: 2, functions_covered: 2,
        lines_total: 10, lines_covered: 8,
      },
    });
    const msg = buildFastUserMessage(task, sampleContent);
    expect(msg).toContain('## Coverage');
    expect(msg).toContain('Statements: 80.0%');
    expect(msg).toContain('Functions: 100.0%');
  });

  it('should not include coverage when absent', () => {
    const msg = buildFastUserMessage(makeTask(), sampleContent);
    expect(msg).not.toContain('## Coverage');
  });

  it('should include usage graph data when provided', () => {
    const graph: UsageGraph = {
      usages: new Map([
        ['add::src/utils/helpers.ts', new Set(['src/commands/run.ts', 'src/core/worker.ts'])],
      ]),
    };
    const options: PromptOptions = { usageGraph: graph };
    const msg = buildFastUserMessage(makeTask(), sampleContent, options);
    expect(msg).toContain('## Pre-computed Import Analysis');
    expect(msg).toContain('add (exported): imported by 2 files');
    expect(msg).toContain('internal (not exported): internal only');
  });

  it('should show LIKELY DEAD for 0 importers', () => {
    const graph: UsageGraph = { usages: new Map() };
    const options: PromptOptions = { usageGraph: graph };
    const msg = buildFastUserMessage(makeTask(), sampleContent, options);
    expect(msg).toContain('add (exported): imported by 0 files');
    expect(msg).toContain('LIKELY DEAD');
  });

  it('should not include usage graph when absent', () => {
    const msg = buildFastUserMessage(makeTask(), sampleContent, {});
    expect(msg).not.toContain('Pre-computed Import Analysis');
  });

  it('should include RAG results when present', () => {
    const options: PromptOptions = {
      ragEnabled: true,
      preResolvedRag: [
        {
          symbolName: 'add',
          lineStart: 1,
          lineEnd: 3,
          results: [
            {
              score: 0.92,
              card: {
                id: 'id-1',
                filePath: 'src/other.ts',
                name: 'sum',
                signature: 'function sum(a: number, b: number): number',
                summary: 'Adds two numbers',
                keyConcepts: ['addition'],
                behavioralProfile: 'pure',
                complexityScore: 1,
                calledInternals: [],
                lastIndexed: '2026-01-01T00:00:00Z',
              },
            },
          ],
        },
      ],
    };
    const msg = buildFastUserMessage(makeTask(), sampleContent, options);
    expect(msg).toContain('## RAG');
    expect(msg).toContain('**sum** in `src/other.ts`');
    expect(msg).toContain('0.920');
  });

  it('should not include RAG section when disabled', () => {
    const msg = buildFastUserMessage(makeTask(), sampleContent, { ragEnabled: false });
    expect(msg).not.toContain('## RAG');
  });

  it('should handle task with no symbols', () => {
    const task = makeTask({ symbols: [] });
    const msg = buildFastUserMessage(task, sampleContent);
    expect(msg).toContain('(no symbols detected)');
  });

  it('should end with review instruction', () => {
    const msg = buildFastUserMessage(makeTask(), sampleContent);
    expect(msg).toContain('Review this file and output the JSON review object.');
  });
});
