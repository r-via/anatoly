// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { buildCorrectionSystemPrompt, buildCorrectionUserMessage, extractVerificationKeywords, CorrectionResponseSchema } from './correction.js';
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
    projectRoot: '/tmp/test',
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
    expect(prompt.split('\n').length).toBeLessThan(220);
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

  it('should include dependency section when fileDeps is provided', () => {
    const msg = buildCorrectionUserMessage(createCtx({
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
    const msg = buildCorrectionUserMessage(createCtx());
    expect(msg).not.toContain('## Project Dependencies');
  });

  it('should omit dependency section when fileDeps has no deps', () => {
    const msg = buildCorrectionUserMessage(createCtx({
      fileDeps: { deps: [] },
    }));
    expect(msg).not.toContain('## Project Dependencies');
  });
});

describe('extractVerificationKeywords', () => {
  it('should extract meaningful terms from finding details', () => {
    const findings = {
      symbols: [
        {
          name: 'handleRequest',
          line_start: 1,
          line_end: 20,
          correction: 'NEEDS_FIX' as const,
          confidence: 85,
          detail: 'The async action callback has no try/catch for error handling. Promise rejections may go unhandled.',
        },
      ],
      actions: [],
    };
    const keywords = extractVerificationKeywords(findings);
    expect(keywords).toContain('async');
    expect(keywords).toContain('action');
    expect(keywords).toContain('error');
    expect(keywords).toContain('promise');
    expect(keywords).toContain('handling');
    expect(keywords).toContain('rejections');
  });

  it('should filter stop words', () => {
    const findings = {
      symbols: [
        {
          name: 'foo',
          line_start: 1,
          line_end: 5,
          correction: 'NEEDS_FIX' as const,
          confidence: 80,
          detail: 'This function will throw when called with undefined values from the callback',
        },
      ],
      actions: [],
    };
    const keywords = extractVerificationKeywords(findings);
    expect(keywords).not.toContain('this');
    expect(keywords).not.toContain('will');
    expect(keywords).not.toContain('when');
    expect(keywords).not.toContain('with');
    expect(keywords).not.toContain('from');
    expect(keywords).toContain('function');
    expect(keywords).toContain('throw');
    expect(keywords).toContain('undefined');
    expect(keywords).toContain('callback');
  });

  it('should skip OK symbols', () => {
    const findings = {
      symbols: [
        {
          name: 'safeFunc',
          line_start: 1,
          line_end: 5,
          correction: 'OK' as const,
          confidence: 95,
          detail: 'No issues found with async error handling in this function.',
        },
      ],
      actions: [],
    };
    const keywords = extractVerificationKeywords(findings);
    expect(keywords).toHaveLength(0);
  });
});

describe('CorrectionResponseSchema with multi-defect findings', () => {
  it('accepts a symbol with no findings (single-defect, backward-compatible)', () => {
    const raw = {
      symbols: [
        {
          name: 'paginate',
          line_start: 1,
          line_end: 10,
          correction: 'NEEDS_FIX' as const,
          confidence: 90,
          detail: 'Off-by-one in slice bounds.',
        },
      ],
      actions: [],
    };
    const parsed = CorrectionResponseSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.symbols[0].findings).toBeUndefined();
    }
  });

  it('accepts a symbol with multiple distinct findings on different lines', () => {
    // Regression: a function carrying both a wrong-sign multiplier and a
    // Math.ceil-instead-of-floor bug used to collapse into a single
    // detail paragraph; consumers had no way to count the second defect.
    // The findings array now lets the LLM enumerate them separately.
    const raw = {
      symbols: [
        {
          name: 'computePayout',
          line_start: 101,
          line_end: 111,
          correction: 'NEEDS_FIX' as const,
          confidence: 95,
          detail: 'Two independent defects: wrong-sign house edge and ceil rounding.',
          findings: [
            {
              line_start: 105,
              line_end: 105,
              detail: 'House edge applied as (1 + HOUSE_EDGE) instead of (1 - HOUSE_EDGE).',
            },
            {
              line_start: 109,
              line_end: 109,
              detail: 'Math.ceil rounds payouts up; should be Math.floor for the house to keep the remainder.',
            },
          ],
        },
      ],
      actions: [],
    };
    const parsed = CorrectionResponseSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.symbols[0].findings).toHaveLength(2);
      expect(parsed.data.symbols[0].findings?.[0].line_start).toBe(105);
      expect(parsed.data.symbols[0].findings?.[1].line_start).toBe(109);
    }
  });
});

describe('buildCorrectionSystemPrompt — multi-defect guidance', () => {
  it('includes the findings-array instruction so the LLM knows to enumerate distinct defects', () => {
    const prompt = buildCorrectionSystemPrompt();
    // The prompt must mention the findings array and instruct the model
    // not to collapse multiple defects into a single detail paragraph.
    expect(prompt).toMatch(/findings/);
    expect(prompt.toLowerCase()).toContain('one finding per defect');
  });
});

describe('buildCorrectionSystemPrompt — domain-awareness guidance', () => {
  it('instructs the LLM to apply industry-specific correctness rules from pretrained knowledge', () => {
    const prompt = buildCorrectionSystemPrompt();
    // The prompt must explicitly invite the model to bring in industry
    // knowledge (e.g. gaming RNG must be certifiable, monetary code must
    // use exact arithmetic). Guards against speculation are also part of
    // the contract.
    expect(prompt.toLowerCase()).toContain('industry');
    expect(prompt.toLowerCase()).toContain('domain');
    expect(prompt).toMatch(/Math\.random/i);
    // Discipline anchors: "confident" + "do NOT flag" / silence-better-than-speculation.
    expect(prompt.toLowerCase()).toContain('confident');
    expect(prompt.toLowerCase()).toMatch(/silence|do not flag|do not speculate/);
  });
});

describe('buildCorrectionSystemPrompt — anti-collapse / source-not-consumer guidance', () => {
  it('instructs the LLM to flag the defect at its source file, not at the consumer', () => {
    // Regression mitigation for the LLM-variance pattern observed on
    // engine.ts::spin (which calls three helpers): some runs the model
    // emits one finding on the caller, other runs three findings on the
    // sources. We want the source behavior, deterministically.
    const prompt = buildCorrectionSystemPrompt();
    expect(prompt.toLowerCase()).toMatch(/source.*defect|defect.*source|where.*defined|canonical home/);
    expect(prompt.toLowerCase()).toMatch(/consumer|caller/);
    expect(prompt.toLowerCase()).toMatch(/aggreg|collaps|burie/);
  });
});

describe('buildCorrectionSystemPrompt — numerical-claim verification with self-validation', () => {
  it('instructs the LLM to derive numerical claims forward AND backward and sanity-check before flagging', () => {
    // LLMs are unreliable at arithmetic without scaffolding. The rule
    // forces a forward derivation (code → implied value), a backward
    // derivation (target → expected constants), and a self-consistency
    // check (backward then forward should return the target). Without
    // the sanity check passing, the LLM must abstain — silence beats
    // confident-but-wrong math.
    const prompt = buildCorrectionSystemPrompt();
    expect(prompt.toLowerCase()).toMatch(/forward.*derivation|derive.*forward/);
    expect(prompt.toLowerCase()).toMatch(/backward.*derivation|derive.*backward/);
    expect(prompt.toLowerCase()).toMatch(/sanity check|self-consistency/);
    // Order-of-magnitude bias: prompt should explicitly favor bounds
    // over precise values, and discipline should require abstaining
    // when the sanity check fails.
    expect(prompt.toLowerCase()).toMatch(/order.of.magnitude|order-of-magnitude|bound/);
    expect(prompt.toLowerCase()).toMatch(/silence|do not flag|abstain/);
  });
});
