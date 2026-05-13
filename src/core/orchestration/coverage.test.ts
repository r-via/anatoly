// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 56.10 — KPI 1: Orchestration coverage regression tests.
 *
 * Ensures every canonical phase routes through `runPhase`, every axis
 * evaluator has a matching composer, and every composer step that references
 * a primitive resolves to a registered entry.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_PHASES } from './run-phase.js';
import { PRIMITIVES } from './registry/primitives/index.js';
import { COMPOSERS } from './registry/composers/index.js';

const root = process.cwd();
const runTs = readFileSync(join(root, 'src', 'commands', 'run.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// KPI 1a: Every canonical phase routes through runPhase in run.ts
// ---------------------------------------------------------------------------

describe('KPI 1a: every canonical phase routes through runPhase', () => {
  for (const phase of CANONICAL_PHASES) {
    it(`phase "${phase}" is invoked via runPhase(ctx, '${phase}', ...)`, () => {
      // The pattern in run.ts is: runPhase(ctx, '<phase>', async () => ...)
      const pattern = `runPhase(ctx, '${phase}'`;
      expect(runTs).toContain(pattern);
    });
  }
});

// ---------------------------------------------------------------------------
// KPI 1b: Every axis in the evaluator list has a matching composer
// ---------------------------------------------------------------------------

const AXIS_IDS = [
  'utility',
  'duplication',
  'correction',
  'overengineering',
  'tests',
  'best-practices',
  'documentation',
] as const;

describe('KPI 1b: every axis has a matching composer in the registry', () => {
  for (const axis of AXIS_IDS) {
    it(`axis "${axis}" has a registered composer "axes.${axis}"`, () => {
      expect(COMPOSERS.has(`axes.${axis}`)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// KPI 1c: Every composer step referencing a primitive resolves to a
//         registered primitive entry
// ---------------------------------------------------------------------------

describe('KPI 1c: every composer step primitive resolves to a registered entry', () => {
  for (const [name, composer] of COMPOSERS) {
    for (const step of composer.plan.steps) {
      if (step.primitive) {
        it(`composer "${name}" step "${step.id}" primitive "${step.primitive}" is registered`, () => {
          expect(PRIMITIVES.has(step.primitive!)).toBe(true);
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// KPI 1d: No inline phase plumbing leaks — only runPhase handles
//         phase_start/phase_end timeline pushes
// ---------------------------------------------------------------------------

describe('KPI 1d: no inline phase plumbing leaks in phase helpers', () => {
  // After Story 56.8, helper functions should not push phase_start/phase_end
  // directly. Only runPhase (in run-phase.ts) should emit these events.
  // Check that run.ts helper functions don't contain manual plumbing.

  it('run.ts has no manual ctx.phaseDurations[...] = assignments outside runPhase', () => {
    // Find all phaseDurations assignments in run.ts
    const assignments = [...runTs.matchAll(/ctx\.phaseDurations\[/g)];
    // There should be zero — runPhase handles all duration tracking
    expect(assignments.length).toBe(0);
  });

  it('run.ts has no manual phase_start timeline pushes outside runPhase', () => {
    // Match literal event: 'phase_start' pushes in run.ts
    const pushes = [...runTs.matchAll(/event:\s*['"]phase_start['"]/g)];
    expect(pushes.length).toBe(0);
  });

  it('run.ts has no manual phase_end timeline pushes outside runPhase', () => {
    const pushes = [...runTs.matchAll(/event:\s*['"]phase_end['"]/g)];
    expect(pushes.length).toBe(0);
  });
});
