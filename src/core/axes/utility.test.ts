// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { buildUtilitySystemPrompt, buildUtilityUserMessage, serializeUtilityDetail, UtilityResponseSchema } from './utility.js';
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
  intraFileRefs: new Map(),
  noImportFiles: new Set(),
};

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task: mockTask,
    fileContent: 'export function formatNumber(n: number): string {\n  return padLeft(n.toString());\n}\n\nfunction padLeft(s: string): string {\n  return s.padStart(10);\n}\n\nexport const MAX_WIDTH = 80;\n',
    config: mockConfig,
    projectRoot: '/tmp/test',
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
  });

  it('should describe the structured evidence + telegraphic note format', () => {
    const prompt = buildUtilitySystemPrompt();
    expect(prompt).toContain('evidence');
    expect(prompt).toContain('runtime_importers');
    expect(prompt).toContain('type_importers');
    expect(prompt).toContain('transitive');
    expect(prompt).toContain('note');
    expect(prompt).toContain('Telegraphic');
  });
});

describe('serializeUtilityDetail', () => {
  it('should format exported symbol with runtime importers', () => {
    const result = serializeUtilityDetail(
      { runtime_importers: 3, type_importers: 0, local_refs: 0, transitive: false, exported: true },
      '',
    );
    expect(result).toBe('3 runtime imp');
  });

  it('should format exported symbol with both runtime and type importers', () => {
    const result = serializeUtilityDetail(
      { runtime_importers: 2, type_importers: 1, local_refs: 0, transitive: false, exported: true },
      '',
    );
    expect(result).toBe('2 runtime imp. 1 type imp');
  });

  it('should format exported symbol with only type importers', () => {
    const result = serializeUtilityDetail(
      { runtime_importers: 0, type_importers: 1, local_refs: 0, transitive: false, exported: true },
      '',
    );
    expect(result).toBe('1 type imp');
  });

  it('should format dead exported symbol', () => {
    const result = serializeUtilityDetail(
      { runtime_importers: 0, type_importers: 0, local_refs: 0, transitive: false, exported: true },
      'exported. no consumers.',
    );
    expect(result).toBe('0 importers. exported. no consumers.');
  });

  it('should format non-exported symbol with local refs', () => {
    const result = serializeUtilityDetail(
      { runtime_importers: 0, type_importers: 0, local_refs: 2, transitive: false, exported: false },
      '',
    );
    expect(result).toBe('2 local refs');
  });

  it('should include transitive marker when set', () => {
    const result = serializeUtilityDetail(
      { runtime_importers: 0, type_importers: 0, local_refs: 0, transitive: true, exported: true },
      'via foo, bar',
    );
    expect(result).toBe('0 importers. transitive. via foo, bar');
  });

  it('should produce short strings compared to prose baseline', () => {
    const prose = 'Runtime-imported by 3 files: foo.ts, bar.ts, baz.ts';
    const terse = serializeUtilityDetail(
      { runtime_importers: 3, type_importers: 0, local_refs: 0, transitive: false, exported: true },
      '',
    );
    expect(terse.length).toBeLessThan(prose.length / 3);
  });
});

describe('UtilityResponseSchema', () => {
  it('should parse a valid LLM response with evidence and empty note', () => {
    const response = {
      symbols: [
        {
          name: 'formatNumber',
          line_start: 1,
          line_end: 10,
          utility: 'USED',
          confidence: 95,
          evidence: {
            runtime_importers: 2,
            type_importers: 0,
            local_refs: 0,
            transitive: false,
            exported: true,
          },
          note: '',
        },
      ],
    };
    const parsed = UtilityResponseSchema.parse(response);
    expect(parsed.symbols[0].utility).toBe('USED');
    expect(parsed.symbols[0].evidence.runtime_importers).toBe(2);
  });

  it('should parse a dead-code finding with telegraphic note', () => {
    const response = {
      symbols: [
        {
          name: 'deadHelper',
          line_start: 15,
          line_end: 25,
          utility: 'DEAD',
          confidence: 95,
          evidence: {
            runtime_importers: 0,
            type_importers: 0,
            local_refs: 0,
            transitive: false,
            exported: true,
          },
          note: 'no importers. no local refs. safe to remove.',
        },
      ],
    };
    const parsed = UtilityResponseSchema.parse(response);
    expect(parsed.symbols[0].utility).toBe('DEAD');
    expect(parsed.symbols[0].note).toContain('safe to remove');
  });

  it('should reject response missing evidence field', () => {
    const response = {
      symbols: [
        {
          name: 'x',
          line_start: 1,
          line_end: 2,
          utility: 'USED',
          confidence: 95,
          note: '',
        },
      ],
    };
    expect(() => UtilityResponseSchema.parse(response)).toThrow();
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
