import { describe, it, expect } from 'vitest';
import { buildCorrectionSystemPrompt, buildCorrectionUserMessage } from './correction.js';
import type { AxisContext } from '../axis-evaluator.js';
import type { Task } from '../../schemas/task.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

const mockTask: Task = {
  version: 1,
  file: 'src/core/parser.ts',
  hash: 'abc123',
  symbols: [
    { name: 'parseConfig', kind: 'function', exported: true, line_start: 1, line_end: 20 },
    { name: 'validateInput', kind: 'function', exported: false, line_start: 22, line_end: 35 },
  ],
  scanned_at: '2026-02-25T00:00:00Z',
};

const mockConfig: Config = ConfigSchema.parse({});

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task: mockTask,
    fileContent: 'export function parseConfig(raw: string) {\n  return JSON.parse(raw);\n}\n\nfunction validateInput(x: unknown): boolean {\n  return typeof x === "string";\n}\n',
    config: mockConfig,
    ...overrides,
  };
}

describe('buildCorrectionSystemPrompt', () => {
  it('should produce a focused prompt mentioning only correction', () => {
    const prompt = buildCorrectionSystemPrompt();
    expect(prompt).toContain('correction');
    expect(prompt).toContain('OK');
    expect(prompt).toContain('NEEDS_FIX');
    expect(prompt).toContain('ERROR');
    expect(prompt).toContain('actions');
    expect(prompt).not.toContain('duplication');
    expect(prompt).not.toContain('utility');
    expect(prompt.split('\n').length).toBeLessThan(50);
  });
});

describe('buildCorrectionUserMessage', () => {
  it('should include file content and symbols', () => {
    const msg = buildCorrectionUserMessage(createCtx());
    expect(msg).toContain('src/core/parser.ts');
    expect(msg).toContain('parseConfig');
    expect(msg).toContain('validateInput');
    expect(msg).toContain('JSON.parse');
  });

  it('should list symbols with line ranges', () => {
    const msg = buildCorrectionUserMessage(createCtx());
    expect(msg).toContain('export function parseConfig (L1–L20)');
    expect(msg).toContain('function validateInput (L22–L35)');
  });
});
