import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserPrompt } from './prompt-builder.js';
import type { Task } from '../schemas/task.js';

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

describe('buildUserPrompt', () => {
  it('should reference the file', () => {
    const prompt = buildUserPrompt(makeTask());
    expect(prompt).toContain('src/utils/format.ts');
  });
});
