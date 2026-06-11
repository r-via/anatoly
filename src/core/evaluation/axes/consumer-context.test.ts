// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { parseTestConfig } from '../../../schemas/test-fixtures.js';
import { renderConsumerContext } from './consumer-context.js';
import { buildCorrectionUserMessage } from './correction.js';
import { buildUtilityUserMessage } from './utility.js';
import { buildDuplicationUserMessage } from './duplication.js';
import { buildOverengineeringUserMessage } from './overengineering.js';
import { buildBestPracticesUserMessage } from './best-practices.js';
import { buildDocumentationUserMessage } from './documentation.js';
import { buildTestsUserMessage } from './tests.js';
import type { AxisContext, ConsumerContext } from '../contract.js';
import type { Task } from '../../../schemas/task.js';

const task: Task = {
  version: 1,
  file: 'src/engine.ts',
  hash: 'h',
  symbols: [
    { name: 'computePayout', kind: 'function', exported: true, line_start: 1, line_end: 10 },
  ],
  scanned_at: '2026-02-25T00:00:00Z',
};

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task,
    fileContent: 'export function computePayout() { return 1; }\n',
    config: parseTestConfig({}),
    projectRoot: '/tmp/test',
    ...overrides,
  };
}

const sample: ConsumerContext[] = [
  {
    symbol: 'computePayout',
    consumers: [
      {
        file: 'src/api.ts',
        name: 'handleSpin',
        signature: 'function handleSpin(bet: number): SpinResult',
        summary: 'validates the bet then returns the spin payout to the caller',
      },
    ],
  },
];

describe('renderConsumerContext', () => {
  it('returns empty string when no consumer context is present', () => {
    expect(renderConsumerContext(createCtx())).toBe('');
    expect(renderConsumerContext(createCtx({ consumerContext: [] }))).toBe('');
  });

  it('renders each exported symbol with its consumer functions', () => {
    const out = renderConsumerContext(createCtx({ consumerContext: sample }));
    expect(out).toContain("## Consumers (how this file's exports are used)");
    expect(out).toContain('`computePayout` is consumed by:');
    expect(out).toContain('`function handleSpin(bet: number): SpinResult` (src/api.ts)');
    expect(out).toContain('validates the bet then returns the spin payout');
  });

  it('truncates long consumer lists with a "…and N more"', () => {
    const many: ConsumerContext[] = [{
      symbol: 'computePayout',
      consumers: Array.from({ length: 9 }, (_, i) => ({
        file: `src/c${i}.ts`, name: `fn${i}`, signature: `function fn${i}()`,
      })),
    }];
    const out = renderConsumerContext(createCtx({ consumerContext: many }));
    expect(out).toMatch(/…and 3 more/);
  });

  it('renders a consumer without a summary cleanly', () => {
    const out = renderConsumerContext(createCtx({
      consumerContext: [{ symbol: 'computePayout', consumers: [{ file: 'src/a.ts', name: 'g', signature: 'function g()' }] }],
    }));
    const line = out.split('\n').find((l) => l.includes('function g()'))!;
    expect(line).toBe('  - `function g()` (src/a.ts)');
  });

  it('states the static-reference caveat (evidence, not proof)', () => {
    const out = renderConsumerContext(createCtx({ consumerContext: sample }));
    expect(out.toLowerCase()).toMatch(/static-reference|evidence, not proof/);
  });
});

describe('consumer context is wired into every axis user message', () => {
  const builders: Array<[string, (ctx: AxisContext) => string]> = [
    ['correction', buildCorrectionUserMessage],
    ['utility', buildUtilityUserMessage],
    ['duplication', buildDuplicationUserMessage],
    ['overengineering', buildOverengineeringUserMessage],
    ['best-practices', buildBestPracticesUserMessage],
    ['documentation', buildDocumentationUserMessage],
    ['tests', buildTestsUserMessage],
  ];

  for (const [name, build] of builders) {
    it(`${name} includes the Consumers section when consumerContext is present`, () => {
      const msg = build(createCtx({ consumerContext: sample }));
      expect(msg).toContain("## Consumers (how this file's exports are used)");
      expect(msg).toContain('handleSpin');
    });

    it(`${name} omits the Consumers section when consumerContext is absent`, () => {
      const msg = build(createCtx());
      expect(msg).not.toContain('## Consumers (how');
    });
  }
});
