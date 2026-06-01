// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { computeAxisPromptHash } from './axes-prompt-hash.js';

// Use synthetic axis ids: resolveSystemPrompt throws for them, so the function
// falls back to hashing the axis id itself. That keeps the test hermetic (no
// dependency on bundled prompt files) while still exercising the hash inputs.
describe('computeAxisPromptHash', () => {
  it('is deterministic for the same (axis, model)', () => {
    expect(computeAxisPromptHash('__axis_a__', 'm1')).toBe(computeAxisPromptHash('__axis_a__', 'm1'));
  });

  it('changes when the model changes (per-axis model is part of the key)', () => {
    expect(computeAxisPromptHash('__axis_a__', 'm1')).not.toBe(computeAxisPromptHash('__axis_a__', 'm2'));
  });

  it('changes when the axis (prompt source) changes', () => {
    expect(computeAxisPromptHash('__axis_a__', 'm1')).not.toBe(computeAxisPromptHash('__axis_b__', 'm1'));
  });

  it('returns a sha256-prefixed digest', () => {
    expect(computeAxisPromptHash('__axis_a__', 'm1')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
