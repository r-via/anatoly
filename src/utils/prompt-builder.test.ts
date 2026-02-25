import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserPrompt } from './prompt-builder.js';
import type { PreResolvedRag } from './prompt-builder.js';
import type { Task } from '../schemas/task.js';
import type { FunctionCard } from '../rag/types.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    version: 1,
    file: 'src/utils/format.ts',
    hash: 'abc123',
    symbols: [
      { name: 'formatName', kind: 'function', exported: true, line_start: 1, line_end: 5 },
      { name: 'MAX_LENGTH', kind: 'constant', exported: true, line_start: 7, line_end: 7 },
    ],
    scanned_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('should include the file path', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).toContain('src/utils/format.ts');
  });

  it('should list all symbols with their kinds', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).toContain('export function formatName');
    expect(prompt).toContain('export constant MAX_LENGTH');
  });

  it('should include coverage data when present', () => {
    const task = makeTask({
      coverage: {
        statements_total: 10,
        statements_covered: 8,
        branches_total: 4,
        branches_covered: 2,
        functions_total: 3,
        functions_covered: 3,
        lines_total: 15,
        lines_covered: 12,
      },
    });
    const prompt = buildSystemPrompt(task);
    expect(prompt).toContain('80.0%');
    expect(prompt).toContain('Statements');
    expect(prompt).toContain('Functions');
  });

  it('should indicate no coverage when not available', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).toContain('not available');
  });

  it('should include the 5 evaluation axes', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).toContain('correction');
    expect(prompt).toContain('overengineering');
    expect(prompt).toContain('utility');
    expect(prompt).toContain('duplication');
    expect(prompt).toContain('tests');
  });

  it('should include investigation rules', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).toContain('NEVER guess');
    expect(prompt).toContain('DEAD');
    expect(prompt).toContain('DUPLICATE');
  });
});

describe('buildSystemPrompt with pre-resolved RAG', () => {
  const makeCard = (overrides: Partial<FunctionCard> = {}): FunctionCard => ({
    id: 'abcdef0123456789',
    filePath: 'src/other.ts',
    name: 'otherFn',
    signature: 'function otherFn(): void',
    summary: 'Does something similar.',
    keyConcepts: ['util'],
    behavioralProfile: 'pure',
    complexityScore: 2,
    calledInternals: [],
    lastIndexed: '2026-01-01T00:00:00Z',
    ...overrides,
  });

  it('should render pre-resolved RAG section with matches and no-matches', () => {
    const rag: PreResolvedRag = [
      {
        symbolName: 'formatName',
        lineStart: 1,
        lineEnd: 5,
        results: [{ card: makeCard(), score: 0.92 }],
      },
      {
        symbolName: 'parseName',
        lineStart: 10,
        lineEnd: 20,
        results: [],
      },
    ];
    const prompt = buildSystemPrompt(makeTask(), { ragEnabled: true, preResolvedRag: rag });
    expect(prompt).toContain('## RAG — Semantic Duplication (pre-resolved)');
    expect(prompt).toContain('### formatName (L1–L5)');
    expect(prompt).toContain('**otherFn** in `src/other.ts` (score: 0.920)');
    expect(prompt).toContain('### parseName (L10–L20)');
    expect(prompt).toContain('No similar functions found.');
  });

  it('should render barrel export message for empty RAG array', () => {
    const prompt = buildSystemPrompt(makeTask(), { ragEnabled: true, preResolvedRag: [] });
    expect(prompt).toContain('No functions to check for duplication (barrel export / type-only file)');
  });

  it('should render not-indexed message for null results', () => {
    const rag: PreResolvedRag = [
      {
        symbolName: 'newFn',
        lineStart: 1,
        lineEnd: 10,
        results: null,
      },
    ];
    const prompt = buildSystemPrompt(makeTask(), { ragEnabled: true, preResolvedRag: rag });
    expect(prompt).toContain('### newFn (L1–L10)');
    expect(prompt).toContain('Function not indexed — cannot check for duplication.');
  });

  it('should not include RAG section when ragEnabled is false', () => {
    const prompt = buildSystemPrompt(makeTask(), { ragEnabled: false });
    expect(prompt).not.toContain('RAG');
  });

  it('should not include RAG section when ragEnabled is true but preResolvedRag is undefined', () => {
    const prompt = buildSystemPrompt(makeTask(), { ragEnabled: true });
    expect(prompt).not.toContain('RAG');
  });
});

describe('buildSystemPrompt with usage graph', () => {
  it('should render usage section with importers', () => {
    const usageGraph = {
      usages: new Map([
        ['formatName::src/utils/format.ts', new Set(['src/core/reporter.ts', 'src/commands/run.ts'])],
      ]),
    };
    const prompt = buildSystemPrompt(makeTask(), { usageGraph });
    expect(prompt).toContain('## Pre-computed Import Analysis');
    expect(prompt).toContain('formatName (exported): imported by 2 files: src/commands/run.ts, src/core/reporter.ts');
    // MAX_LENGTH has 0 importers
    expect(prompt).toContain('MAX_LENGTH (exported): imported by 0 files');
    expect(prompt).toContain('LIKELY DEAD');
  });

  it('should show "internal only" for non-exported symbols', () => {
    const task = makeTask({
      symbols: [
        { name: 'helper', kind: 'function', exported: false, line_start: 1, line_end: 10 },
      ],
    });
    const usageGraph = { usages: new Map() };
    const prompt = buildSystemPrompt(task, { usageGraph });
    expect(prompt).toContain('helper (not exported): internal only');
  });

  it('should add rule 6 about not grepping for imports', () => {
    const usageGraph = { usages: new Map() };
    const prompt = buildSystemPrompt(makeTask(), { usageGraph });
    expect(prompt).toContain('Do NOT grep for imports');
    expect(prompt).toContain('this data is exhaustive');
  });

  it('should not include usage section when usageGraph is undefined (backward compatible)', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).not.toContain('Pre-computed Import Analysis');
    expect(prompt).not.toContain('Do NOT grep for imports');
  });

  it('should not render usage section for task with 0 symbols', () => {
    const task = makeTask({ symbols: [] });
    const usageGraph = { usages: new Map() };
    const prompt = buildSystemPrompt(task, { usageGraph });
    expect(prompt).not.toContain('Pre-computed Import Analysis');
  });
});

describe('buildUserPrompt', () => {
  it('should reference the file', () => {
    const prompt = buildUserPrompt(makeTask());
    expect(prompt).toContain('src/utils/format.ts');
  });
});
