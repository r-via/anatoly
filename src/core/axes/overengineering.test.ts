import { describe, it, expect } from 'vitest';
import { buildOverengineeringSystemPrompt, buildOverengineeringUserMessage } from './overengineering.js';
import type { AxisContext } from '../axis-evaluator.js';
import type { Task } from '../../schemas/task.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

const mockTask: Task = {
  version: 1,
  file: 'src/utils/factory.ts',
  hash: 'def456',
  symbols: [
    { name: 'createHandler', kind: 'function', exported: true, line_start: 1, line_end: 30 },
    { name: 'HandlerOptions', kind: 'type', exported: true, line_start: 32, line_end: 40 },
  ],
  scanned_at: '2026-02-25T00:00:00Z',
};

const mockConfig: Config = ConfigSchema.parse({});

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task: mockTask,
    fileContent: 'export function createHandler<T>(opts: HandlerOptions<T>) {\n  return new AbstractHandler(opts);\n}\n\nexport type HandlerOptions<T> = {\n  transform: (input: T) => T;\n  validate?: boolean;\n};\n',
    config: mockConfig,
    ...overrides,
  };
}

describe('buildOverengineeringSystemPrompt', () => {
  it('should produce a focused prompt mentioning only overengineering', () => {
    const prompt = buildOverengineeringSystemPrompt();
    expect(prompt).toContain('overengineering');
    expect(prompt).toContain('LEAN');
    expect(prompt).toContain('OVER');
    expect(prompt).toContain('ACCEPTABLE');
    expect(prompt).not.toContain('correction');
    expect(prompt).not.toContain('utility');
    expect(prompt.split('\n').length).toBeLessThan(50);
  });
});

describe('buildOverengineeringUserMessage', () => {
  it('should include file content and symbols', () => {
    const msg = buildOverengineeringUserMessage(createCtx());
    expect(msg).toContain('src/utils/factory.ts');
    expect(msg).toContain('createHandler');
    expect(msg).toContain('HandlerOptions');
  });

  it('should list symbols with kinds and line ranges', () => {
    const msg = buildOverengineeringUserMessage(createCtx());
    expect(msg).toContain('export function createHandler (L1–L30)');
    expect(msg).toContain('export type HandlerOptions (L32–L40)');
  });
});
