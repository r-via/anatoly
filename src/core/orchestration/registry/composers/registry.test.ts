// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeAll } from 'vitest';
import { COMPOSERS } from './index.js';
import type { ComposerEntry } from './types.js';
import type { CentralExchange } from '../../types.js';

// ---------------------------------------------------------------------------
// Expected entries
// ---------------------------------------------------------------------------

const EXPECTED_AXIS_COMPOSERS = [
  'axes.utility',
  'axes.duplication',
  'axes.correction',
  'axes.overengineering',
  'axes.tests',
  'axes.best-practices',
  'axes.documentation',
];

const EXPECTED_PIPELINE_COMPOSERS = [
  'review-pipeline',
  'doc-conflict-pipeline',
  'doc-update-pipeline',
  'refinement-pipeline',
];

const ALL_EXPECTED = [...EXPECTED_AXIS_COMPOSERS, ...EXPECTED_PIPELINE_COMPOSERS];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('COMPOSERS registry', () => {
  it('should contain exactly 11 entries', () => {
    expect(COMPOSERS.size).toBe(11);
  });

  it.each(ALL_EXPECTED)('should contain %s', (name) => {
    expect(COMPOSERS.has(name)).toBe(true);
  });

  describe('ComposerEntry contract', () => {
    for (const [name, entry] of COMPOSERS) {
      describe(name, () => {
        it('should have name matching map key', () => {
          expect(entry.name).toBe(name);
        });

        it('should have a non-empty plan with at least one step', () => {
          expect(entry.plan.steps.length).toBeGreaterThanOrEqual(1);
        });

        it('should have inputSchema as a Zod schema', () => {
          expect(entry.inputSchema).toBeDefined();
          expect(entry.inputSchema._def).toBeDefined();
        });

        it('should have outputSchema as a Zod schema', () => {
          expect(entry.outputSchema).toBeDefined();
          expect(entry.outputSchema._def).toBeDefined();
        });

        it('should have unique step IDs within the plan', () => {
          const ids = entry.plan.steps.map((s) => s.id);
          expect(new Set(ids).size).toBe(ids.length);
        });

        it('should only reference step IDs that exist in readsFrom', () => {
          const ids = new Set(entry.plan.steps.map((s) => s.id));
          for (const step of entry.plan.steps) {
            for (const dep of step.readsFrom ?? []) {
              expect(ids.has(dep)).toBe(true);
            }
          }
        });

        it('should reference either primitive or composer (not both) per step', () => {
          for (const step of entry.plan.steps) {
            if (step.primitive && step.composer) {
              throw new Error(
                `Step "${step.id}" in "${name}" declares both primitive and composer`,
              );
            }
          }
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // axes.correction: 2-step plan
  // -------------------------------------------------------------------------

  describe('axes.correction', () => {
    let correction: ComposerEntry;

    beforeAll(() => {
      correction = COMPOSERS.get('axes.correction')!;
    });

    it('should have a 2-step plan', () => {
      expect(correction.plan.steps).toHaveLength(2);
    });

    it('step[0] should be pass1 referencing axes.correction-pass1', () => {
      const step = correction.plan.steps[0];
      expect(step.id).toBe('pass1');
      expect(step.primitive).toBe('axes.correction-pass1');
    });

    it('step[1] should be verify referencing axes.correction-verify', () => {
      const step = correction.plan.steps[1];
      expect(step.id).toBe('verify');
      expect(step.primitive).toBe('axes.correction-verify');
    });

    it('verify should depend on pass1', () => {
      const verify = correction.plan.steps[1];
      expect(verify.readsFrom).toEqual(['pass1']);
    });

    it('verify should have a condition function', () => {
      const verify = correction.plan.steps[1];
      expect(typeof verify.condition).toBe('function');
    });

    it('verify condition should return false when findings <= 3', () => {
      const verify = correction.plan.steps[1];
      const mockExchange = {
        read: () => ({
          symbols: [
            { name: 'a', correction: 'NEEDS_FIX', findings: [{ description: 'f1', severity: 'low' }] },
            { name: 'b', correction: 'OK' },
          ],
          actions: [],
        }),
        write: () => {},
        has: () => true,
        snapshot: () => ({}),
      } as unknown as CentralExchange;
      expect(verify.condition!(mockExchange)).toBe(false);
    });

    it('verify condition should return true when findings > 3', () => {
      const verify = correction.plan.steps[1];
      const mockExchange = {
        read: () => ({
          symbols: [
            {
              name: 'a',
              correction: 'NEEDS_FIX',
              findings: [
                { description: 'f1', severity: 'low' },
                { description: 'f2', severity: 'med' },
                { description: 'f3', severity: 'high' },
                { description: 'f4', severity: 'low' },
              ],
            },
          ],
          actions: [],
        }),
        write: () => {},
        has: () => true,
        snapshot: () => ({}),
      } as unknown as CentralExchange;
      expect(verify.condition!(mockExchange)).toBe(true);
    });

    it('verify should have onFailure: continue', () => {
      const verify = correction.plan.steps[1];
      expect(verify.onFailure).toBe('continue');
    });
  });

  // -------------------------------------------------------------------------
  // review-pipeline: fan-out + merger
  // -------------------------------------------------------------------------

  describe('review-pipeline', () => {
    let pipeline: ComposerEntry;

    beforeAll(() => {
      pipeline = COMPOSERS.get('review-pipeline')!;
    });

    it('should have 8 steps (7 axes + 1 merger)', () => {
      expect(pipeline.plan.steps).toHaveLength(8);
    });

    it('should fan out 7 axis composers with no mutual dependencies', () => {
      const axisSteps = pipeline.plan.steps.slice(0, 7);
      for (const step of axisSteps) {
        expect(step.composer).toMatch(/^axes\./);
        expect(step.readsFrom).toBeUndefined();
      }
    });

    it('should have axis-merger step reading from all 7 axes', () => {
      const merger = pipeline.plan.steps[7];
      expect(merger.id).toBe('axis-merger');
      expect(merger.readsFrom).toHaveLength(7);
      expect(merger.inputMapper).toBeDefined();
    });

    it('axis-merger inputMapper should merge available axis results', () => {
      const merger = pipeline.plan.steps[7];
      const mockExchange = {
        read: (id: string) => ({ axis: id, score: 5 }),
        write: () => {},
        has: () => true,
        snapshot: () => ({}),
      } as unknown as CentralExchange;
      const result = merger.inputMapper!(mockExchange, {}) as Record<string, unknown>;
      expect(result).toHaveProperty('utility');
      expect(result).toHaveProperty('documentation');
    });
  });

  // -------------------------------------------------------------------------
  // Single-step axis composers
  // -------------------------------------------------------------------------

  describe('single-step axis composers', () => {
    const singleStep = [
      'axes.utility',
      'axes.duplication',
      'axes.overengineering',
      'axes.tests',
      'axes.best-practices',
      'axes.documentation',
    ];

    it.each(singleStep)('%s should have exactly 1 step', (name) => {
      const composer = COMPOSERS.get(name)!;
      expect(composer.plan.steps).toHaveLength(1);
    });

    it.each(singleStep)('%s should reference matching primitive', (name) => {
      const composer = COMPOSERS.get(name)!;
      expect(composer.plan.steps[0].primitive).toBe(name);
    });
  });
});
