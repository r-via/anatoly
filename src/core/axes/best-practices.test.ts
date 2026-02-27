import { describe, it, expect } from 'vitest';
import { buildBestPracticesSystemPrompt, buildBestPracticesUserMessage, detectFileContext } from './best-practices.js';
import type { AxisContext } from '../axis-evaluator.js';
import type { Task } from '../../schemas/task.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

const mockTask: Task = {
  version: 1,
  file: 'src/utils/format.ts',
  hash: 'jkl012',
  symbols: [
    { name: 'formatDate', kind: 'function', exported: true, line_start: 1, line_end: 10 },
    { name: 'padNumber', kind: 'function', exported: false, line_start: 12, line_end: 20 },
  ],
  scanned_at: '2026-02-25T00:00:00Z',
};

const mockConfig: Config = ConfigSchema.parse({});

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task: mockTask,
    fileContent: 'export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n\nfunction padNumber(n: number): string {\n  return n.toString().padStart(2, "0");\n}\n',
    config: mockConfig,
    projectRoot: '/tmp/test',
    ...overrides,
  };
}

describe('detectFileContext', () => {
  it('should detect test files', () => {
    expect(detectFileContext('src/utils/format.test.ts', '')).toBe('test');
    expect(detectFileContext('src/utils/format.spec.ts', '')).toBe('test');
  });

  it('should detect config files', () => {
    expect(detectFileContext('tsup.config.ts', '')).toBe('config');
    expect(detectFileContext('src/config/settings.ts', '')).toBe('config');
  });

  it('should detect React components', () => {
    expect(detectFileContext('src/components/Button.tsx', 'import React from "react";\nexport const Button = () => <div/>;')).toBe('react-component');
  });

  it('should detect API handlers by path', () => {
    expect(detectFileContext('src/api/handler.ts', 'export function handle() {}')).toBe('api-handler');
  });

  it('should detect API handlers by framework import', () => {
    expect(detectFileContext('src/api/users.ts', 'import express from "express";\nexport function handler() {}')).toBe('api-handler');
  });

  it('should detect utility files', () => {
    expect(detectFileContext('src/utils/format.ts', 'export function format() {}')).toBe('utility');
  });

  it('should fall back to general', () => {
    expect(detectFileContext('src/core/engine.ts', 'export class Engine {}')).toBe('general');
  });
});

describe('buildBestPracticesSystemPrompt', () => {
  it('should contain all 17 rules', () => {
    const prompt = buildBestPracticesSystemPrompt();
    expect(prompt).toContain('Strict mode');
    expect(prompt).toContain('No `any`');
    expect(prompt).toContain('Discriminated unions');
    expect(prompt).toContain('Utility types');
    expect(prompt).toContain('Immutability');
    expect(prompt).toContain('Interface vs Type');
    expect(prompt).toContain('File size');
    expect(prompt).toContain('ESLint compliance');
    expect(prompt).toContain('JSDoc');
    expect(prompt).toContain('Modern 2026');
    expect(prompt).toContain('Import organization');
    expect(prompt).toContain('Async/Promises/Error handling');
    expect(prompt).toContain('Security');
    expect(prompt).toContain('Performance');
    expect(prompt).toContain('Testability');
    expect(prompt).toContain('TypeScript 5.5+');
    expect(prompt).toContain('Context-adapted');
  });

  it('should mention scoring from 10', () => {
    const prompt = buildBestPracticesSystemPrompt();
    expect(prompt).toContain('10');
    expect(prompt).toContain('score');
  });

  it('should not mention other axes', () => {
    const prompt = buildBestPracticesSystemPrompt();
    expect(prompt).not.toContain('duplication');
    expect(prompt).not.toContain('overengineering');
  });
});

describe('buildBestPracticesUserMessage', () => {
  it('should include file content and context', () => {
    const msg = buildBestPracticesUserMessage(createCtx());
    expect(msg).toContain('src/utils/format.ts');
    expect(msg).toContain('Context: utility');
    expect(msg).toContain('formatDate');
  });

  it('should include file stats', () => {
    const msg = buildBestPracticesUserMessage(createCtx());
    expect(msg).toContain('Symbols: 2');
    expect(msg).toContain('Exported symbols: 1');
  });

  it('should detect context for test files', () => {
    const testTask: Task = { ...mockTask, file: 'src/utils/format.test.ts' };
    const msg = buildBestPracticesUserMessage(createCtx({ task: testTask }));
    expect(msg).toContain('Context: test');
  });

  it('should include dependency section when fileDeps is provided', () => {
    const msg = buildBestPracticesUserMessage(createCtx({
      fileDeps: {
        deps: [
          { name: 'commander', version: '^14.0.3' },
          { name: 'zod', version: '^3.22.0' },
        ],
        nodeEngine: '>=20.19',
      },
    }));
    expect(msg).toContain('## Project Dependencies');
    expect(msg).toContain('commander: ^14.0.3');
    expect(msg).toContain('zod: ^3.22.0');
    expect(msg).toContain('Node.js engine: >=20.19');
  });

  it('should omit dependency section when fileDeps is not provided', () => {
    const msg = buildBestPracticesUserMessage(createCtx());
    expect(msg).not.toContain('## Project Dependencies');
  });

  it('should omit dependency section when fileDeps has no deps', () => {
    const msg = buildBestPracticesUserMessage(createCtx({
      fileDeps: { deps: [] },
    }));
    expect(msg).not.toContain('## Project Dependencies');
  });
});
