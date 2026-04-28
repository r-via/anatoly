// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

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
    projectRoot: '/tmp/test',
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
  });

  it('should include NIH detection rules', () => {
    const prompt = buildOverengineeringSystemPrompt();
    expect(prompt).toContain('NIH');
    expect(prompt).toContain('Installed dep reimplemented');
  });

  it('instructs the LLM to flag over-engineering at its source pattern, not at the consumer', () => {
    // Regression mitigation: a file that USES several over-engineered
    // helpers defined elsewhere should keep its own verdict LEAN. The
    // OVER verdict belongs on the file that DEFINES the abstraction —
    // otherwise the same architectural defect flips between consumer
    // and source from one run to the next, blowing precision and
    // recall in alternation.
    const prompt = buildOverengineeringSystemPrompt();
    expect(prompt.toLowerCase()).toMatch(/source pattern|abstraction.*own file|defines the abstraction|where.*defined/);
    expect(prompt.toLowerCase()).toMatch(/consumer|call(er|ed)/);
    expect(prompt.toLowerCase()).toMatch(/unstable|run-to-run|stable/);
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

  it('should include installed dependencies when fileDeps is provided', () => {
    const msg = buildOverengineeringUserMessage(createCtx({
      fileDeps: {
        deps: [
          { name: 'lodash', version: '4.17.21' },
          { name: 'zod', version: '3.23.0' },
        ],
      },
    }));
    expect(msg).toContain('## Installed Dependencies');
    expect(msg).toContain('- lodash: 4.17.21');
    expect(msg).toContain('- zod: 3.23.0');
  });

  it('should omit dependencies section when fileDeps is undefined', () => {
    const msg = buildOverengineeringUserMessage(createCtx());
    expect(msg).not.toContain('Installed Dependencies');
  });

  it('should omit dependencies section when deps array is empty', () => {
    const msg = buildOverengineeringUserMessage(createCtx({
      fileDeps: { deps: [] },
    }));
    expect(msg).not.toContain('Installed Dependencies');
  });
});
