// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  DeliberationResponseSchema,
  buildDeliberationSystemPrompt,
  buildDeliberationUserMessage,
  needsDeliberation,
  applyDeliberation,
} from './deliberation.js';
import type { DeliberationResponse } from './deliberation.js';
import type { ReviewFile } from '../../schemas/review.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReview(overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    version: 2,
    file: 'src/example.ts',
    is_generated: false,
    verdict: 'CLEAN',
    symbols: [
      {
        name: 'doWork',
        kind: 'function',
        exported: true,
        line_start: 1,
        line_end: 10,
        correction: 'OK',
        overengineering: 'LEAN',
        utility: 'USED',
        duplication: 'UNIQUE',
        tests: 'GOOD',
        documentation: '-',
        flow: '-',
        confidence: 95,
        detail: 'All good',
        duplicate_target: undefined,
      },
    ],
    actions: [],
    file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' },
    ...overrides,
  };
}

function makeDeliberationResponse(overrides: Partial<DeliberationResponse> = {}): DeliberationResponse {
  return {
    verdict: 'CLEAN',
    symbols: [
      {
        name: 'doWork',
        original: { correction: 'OK', confidence: 95 },
        deliberated: { correction: 'OK', confidence: 95 },
        reasoning: 'Assessment is correct, no changes needed',
      },
    ],
    removed_actions: [],
    reasoning: 'All findings are consistent and accurate',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('DeliberationResponseSchema', () => {
  it('should validate a correct response', () => {
    const input = {
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'foo',
          original: { correction: 'NEEDS_FIX', confidence: 72 },
          deliberated: { correction: 'OK', confidence: 90 },
          reasoning: 'The pattern is safe in this library version',
        },
      ],
      removed_actions: [1, 3],
      reasoning: 'Overall the code is clean after reclassification',
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should reject response with missing reasoning', () => {
    const input = {
      verdict: 'CLEAN',
      symbols: [],
      removed_actions: [],
      reasoning: 'short', // < 10 chars
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject invalid verdict', () => {
    const input = {
      verdict: 'UNKNOWN',
      symbols: [],
      removed_actions: [],
      reasoning: 'Overall assessment is fine',
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should accept documentation axis in verdict', () => {
    const input = {
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        {
          name: 'foo',
          original: { documentation: 'UNDOCUMENTED', confidence: 95 },
          deliberated: { documentation: 'DOCUMENTED', confidence: 90 },
          reasoning: 'Self-descriptive type does not need JSDoc',
        },
      ],
      removed_actions: [],
      reasoning: 'Documentation reclassified for self-descriptive types',
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should accept the flow axis in verdict', () => {
    const input = {
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'AppRoutes',
          original: { flow: 'NEEDS_FIX', confidence: 100 },
          deliberated: { flow: 'OK', confidence: 90 },
          reasoning: 'Grepped a dynamic route registry caller the static walk missed',
        },
      ],
      removed_actions: [],
      reasoning: 'Flow unwired_flow false positive: entry is wired via a runtime registry',
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should default removed_actions to empty array', () => {
    const input = {
      verdict: 'CLEAN',
      symbols: [],
      reasoning: 'Overall assessment is fine enough',
    };
    const result = DeliberationResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.removed_actions).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt builder tests
// ---------------------------------------------------------------------------

describe('buildDeliberationSystemPrompt', () => {
  it('should define the judge role', () => {
    const prompt = buildDeliberationSystemPrompt();
    expect(prompt).toContain('Deliberation Judge');
    expect(prompt).toContain('FINAL validation pass');
  });

  it('should forbid adding new findings', () => {
    const prompt = buildDeliberationSystemPrompt();
    expect(prompt).toContain('MUST NOT add new findings');
  });

  it('should require confidence >= 85', () => {
    const prompt = buildDeliberationSystemPrompt();
    expect(prompt).toContain('85');
  });

  it('should protect ERROR findings', () => {
    const prompt = buildDeliberationSystemPrompt();
    expect(prompt).toContain('ERROR → OK');
    expect(prompt).toContain('95');
  });
});

describe('buildDeliberationUserMessage', () => {
  it('should include ReviewFile JSON', () => {
    const review = makeReview();
    const msg = buildDeliberationUserMessage(review, 'const x = 1;');
    expect(msg).toContain('"file": "src/example.ts"');
    expect(msg).toContain('"verdict": "CLEAN"');
  });

  it('should include source code', () => {
    const review = makeReview();
    const msg = buildDeliberationUserMessage(review, 'export function doWork() { return 42; }');
    expect(msg).toContain('export function doWork()');
  });

  it('should include the file name', () => {
    const review = makeReview({ file: 'src/utils/helper.ts' });
    const msg = buildDeliberationUserMessage(review, 'code');
    expect(msg).toContain('src/utils/helper.ts');
  });
});

// ---------------------------------------------------------------------------
// needsDeliberation tests
// ---------------------------------------------------------------------------

describe('needsDeliberation', () => {
  it('should return false for CLEAN with all confidence >= 95', () => {
    const review = makeReview({
      verdict: 'CLEAN',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 95, detail: 'Clean symbol ok', flow: '-', duplicate_target: undefined },
        { name: 'b', kind: 'function', exported: true, line_start: 6, line_end: 10, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 98, detail: 'Clean symbol ok', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(false);
  });

  it('should return true for symbol with NEEDS_FIX', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'NEEDS_FIX', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 80, detail: 'Has a bug here', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with ERROR', () => {
    const review = makeReview({
      verdict: 'CRITICAL',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'ERROR', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 90, detail: 'Critical error found', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with DEAD utility', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'DEAD', duplication: 'UNIQUE', tests: 'NONE', documentation: '-', confidence: 85, detail: 'Dead code found', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with DUPLICATE', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'DUPLICATE', tests: 'GOOD', documentation: '-', confidence: 85, detail: 'Duplicated elsewhere', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with OVER overengineering', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'OVER', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 85, detail: 'Over-engineered stuff', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for CLEAN with low confidence (< 70)', () => {
    const review = makeReview({
      verdict: 'CLEAN',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 65, detail: 'Low confidence symbol', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with UNDOCUMENTED', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: 'UNDOCUMENTED', confidence: 95, detail: 'No JSDoc comment', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return true for symbol with PARTIAL documentation', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: 'PARTIAL', confidence: 85, detail: 'Incomplete JSDoc', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(true);
  });

  it('should return false for CLEAN with medium confidence (70-94)', () => {
    const review = makeReview({
      verdict: 'CLEAN',
      symbols: [
        { name: 'a', kind: 'function', exported: true, line_start: 1, line_end: 5, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 80, detail: 'Medium confidence ok', flow: '-', duplicate_target: undefined },
      ],
    });
    expect(needsDeliberation(review)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyDeliberation tests
// ---------------------------------------------------------------------------

describe('applyDeliberation', () => {
  it('should reclassify NEEDS_FIX to OK', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'NEEDS_FIX', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 72, detail: 'Possible bug here', flow: '-', duplicate_target: undefined },
      ],
      actions: [{ id: 1, description: 'Fix the bug', severity: 'high', effort: 'small', category: 'refactor', target_symbol: 'doWork', target_lines: 'L1-L10' }],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'NEEDS_FIX', confidence: 72 },
          deliberated: { correction: 'OK', confidence: 90 },
          reasoning: 'The pattern is safe in this context',
        },
      ],
      removed_actions: [1],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.verdict).toBe('CLEAN');
    expect(result.symbols[0].correction).toBe('OK');
    expect(result.symbols[0].confidence).toBe(90);
    expect(result.symbols[0].detail).toContain('correction: NEEDS_FIX → OK');
    expect(result.actions).toHaveLength(0);
  });

  it('should reclassify a flow NEEDS_FIX to OK (deliberation overturns a static false positive)', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'AppRoutes', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: '-', overengineering: '-', utility: '-', duplication: '-', tests: '-', documentation: '-', flow: 'NEEDS_FIX', confidence: 100, detail: '[NEEDS_FIX] unwired_flow: entry has effects but no caller', duplicate_target: undefined },
      ],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'AppRoutes',
          original: { flow: 'NEEDS_FIX', confidence: 100 },
          deliberated: { flow: 'OK', confidence: 90 },
          reasoning: 'Caller exists via the route registry (src/router.ts:42)',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[0].flow).toBe('OK');
    expect(result.symbols[0].detail).toContain('flow: NEEDS_FIX → OK');
  });

  it('reclassifies a file-level best_practices rule (FAIL → PASS) onto review.best_practices', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [],
      best_practices: {
        score: 6,
        rules: [
          { rule_id: 1, rule_name: 'no-console', status: 'FAIL', severity: 'medium', detail: 'console.log left in', lines: '12' },
          { rule_id: 2, rule_name: 'no-any', status: 'PASS', severity: 'low' },
        ],
        suggestions: [],
      },
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'no-console',
          original: { best_practices: 'FAIL', confidence: 80 },
          deliberated: { best_practices: 'PASS', confidence: 95 },
          reasoning: 'The console.log is inside a guarded debug-only branch (src/a.ts:12)',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    const rule = result.best_practices?.rules.find((r) => r.rule_name === 'no-console');
    expect(rule?.status).toBe('PASS');
    // untouched rule stays as-is
    expect(result.best_practices?.rules.find((r) => r.rule_name === 'no-any')?.status).toBe('PASS');
  });

  it('purges stale per-defect findings when correction is reclassified to OK', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'NEEDS_FIX', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 72, detail: 'Possible bug here', flow: '-', duplicate_target: undefined,
          findings: [{ axis: 'correction', line_start: 2, line_end: 3, detail: 'wrong-sign multiplier defect' }] },
      ],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'NEEDS_FIX', confidence: 72 },
          deliberated: { correction: 'OK', confidence: 90 },
          reasoning: 'The pattern is safe in this context',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[0].correction).toBe('OK');
    // An OK symbol must not expose stale correction findings.
    expect(result.symbols[0].findings).toBeUndefined();
  });

  it('ignores a deliberated "-" sentinel (keeps the original verdict, not drops it)', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'NEEDS_FIX', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 72, detail: 'Possible bug', flow: '-', duplicate_target: undefined },
      ],
    });
    const deliberation = makeDeliberationResponse({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'NEEDS_FIX', confidence: 72 },
          deliberated: { correction: '-', confidence: 80 },
          reasoning: 'Model emitted the not-evaluated sentinel',
        },
      ],
    });
    const result = applyDeliberation(review, deliberation);
    // '-' must not be applied; the finding stays NEEDS_FIX rather than silently
    // becoming '-' (which recomputeVerdict would drop entirely).
    expect(result.symbols[0].correction).toBe('NEEDS_FIX');
  });

  it('protects a real ERROR even when the model misreports the original verdict', () => {
    const review = makeReview({
      verdict: 'CRITICAL',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'ERROR', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 90, detail: 'Critical', flow: '-', duplicate_target: undefined },
      ],
    });
    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'doWork',
          // Model hallucinates the original as NEEDS_FIX (it was actually ERROR)
          // and tries to downgrade with low confidence.
          original: { correction: 'NEEDS_FIX', confidence: 90 },
          deliberated: { correction: 'OK', confidence: 88 },
          reasoning: 'I think this is fine',
        },
      ],
    });
    const result = applyDeliberation(review, deliberation);
    // The guard reads the ACTUAL current value (ERROR), so the <95-confidence
    // downgrade is rejected and ERROR is preserved.
    expect(result.symbols[0].correction).toBe('ERROR');
  });

  it('keeps findings of an axis that is still flagged after deliberation', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'NEEDS_FIX', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 72, detail: 'Two bugs', flow: '-', duplicate_target: undefined,
          findings: [{ axis: 'correction', line_start: 2, line_end: 3, detail: 'still a real defect' }] },
      ],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'NEEDS_FIX', confidence: 72 },
          deliberated: { correction: 'NEEDS_FIX', confidence: 80 },
          reasoning: 'Confirmed, still a defect',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[0].correction).toBe('NEEDS_FIX');
    expect(result.symbols[0].findings).toHaveLength(1);
  });

  it('should protect ERROR when Opus confidence < 95', () => {
    const review = makeReview({
      verdict: 'CRITICAL',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'ERROR', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 90, detail: 'Critical error here', flow: '-', duplicate_target: undefined },
      ],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'ERROR', confidence: 90 },
          deliberated: { correction: 'OK', confidence: 88 },
          reasoning: 'I think this is actually fine',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    // ERROR should be protected — correction stays ERROR
    expect(result.symbols[0].correction).toBe('ERROR');
    expect(result.symbols[0].detail).toContain('ERROR protected');
    expect(result.symbols[0].detail).toContain('88 < 95');
  });

  it('should allow ERROR downgrade when Opus confidence >= 95', () => {
    const review = makeReview({
      verdict: 'CRITICAL',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'ERROR', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 90, detail: 'Critical error here', flow: '-', duplicate_target: undefined },
      ],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'ERROR', confidence: 90 },
          deliberated: { correction: 'OK', confidence: 95 },
          reasoning: 'After careful analysis this is a false positive',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[0].correction).toBe('OK');
    expect(result.symbols[0].confidence).toBe(95);
  });

  it('should remove invalidated actions', () => {
    const review = makeReview({
      actions: [
        { id: 1, description: 'Fix bug A', severity: 'high', effort: 'small', category: 'refactor', target_symbol: 'doWork', target_lines: 'L1-L5' },
        { id: 2, description: 'Fix bug B', severity: 'medium', effort: 'small', category: 'refactor', target_symbol: 'doWork', target_lines: 'L6-L10' },
        { id: 3, description: 'Cleanup', severity: 'low', effort: 'trivial', category: 'hygiene', target_symbol: null, target_lines: null },
      ],
    });

    const deliberation = makeDeliberationResponse({
      removed_actions: [1, 3],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].id).toBe(2);
  });

  it('should enrich detail with confirmed reasoning', () => {
    const review = makeReview();
    const deliberation = makeDeliberationResponse({
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'OK', confidence: 95 },
          deliberated: { correction: 'OK', confidence: 95 },
          reasoning: 'Assessment is correct, no changes needed',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[0].detail).toContain('deliberated: confirmed');
    expect(result.symbols[0].detail).toContain('Assessment is correct');
  });

  it('should leave unmentioned symbols unchanged', () => {
    const review = makeReview({
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 95, detail: 'All good stuff', flow: '-', duplicate_target: undefined },
        { name: 'helper', kind: 'function', exported: false, line_start: 11, line_end: 20, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: '-', confidence: 90, detail: 'Also fine code', flow: '-', duplicate_target: undefined },
      ],
    });

    const deliberation = makeDeliberationResponse({
      symbols: [
        {
          name: 'doWork',
          original: { correction: 'OK', confidence: 95 },
          deliberated: { correction: 'OK', confidence: 95 },
          reasoning: 'Assessment is correct for this symbol',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[1].detail).toBe('Also fine code');
    expect(result.symbols[1].confidence).toBe(90);
  });

  it('should reclassify UNDOCUMENTED to DOCUMENTED', () => {
    const review = makeReview({
      verdict: 'NEEDS_REFACTOR',
      symbols: [
        { name: 'doWork', kind: 'function', exported: true, line_start: 1, line_end: 10, correction: 'OK', overengineering: 'LEAN', utility: 'USED', duplication: 'UNIQUE', tests: 'GOOD', documentation: 'UNDOCUMENTED', confidence: 95, detail: 'No JSDoc comment', flow: '-', duplicate_target: undefined },
      ],
    });

    const deliberation = makeDeliberationResponse({
      verdict: 'CLEAN',
      symbols: [
        {
          name: 'doWork',
          original: { documentation: 'UNDOCUMENTED', confidence: 95 },
          deliberated: { documentation: 'DOCUMENTED', confidence: 90 },
          reasoning: 'Self-descriptive type with clear field names, JSDoc not needed',
        },
      ],
    });

    const result = applyDeliberation(review, deliberation);
    expect(result.symbols[0].documentation).toBe('DOCUMENTED');
    expect(result.symbols[0].detail).toContain('documentation: UNDOCUMENTED → DOCUMENTED');
  });

  it('should apply Opus verdict', () => {
    const review = makeReview({ verdict: 'NEEDS_REFACTOR' });
    const deliberation = makeDeliberationResponse({ verdict: 'CLEAN' });

    const result = applyDeliberation(review, deliberation);
    expect(result.verdict).toBe('CLEAN');
  });
});
