// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  isValidSha,
  CircuitBreakerState,
  CB_NO_PROGRESS_THRESHOLD,
  CB_SAME_ERROR_THRESHOLD,
  groupStoriesByAxisFile,
  type PrdStory,
} from './clean-run.js';

describe('isValidSha', () => {
  it('should accept a valid 40-char hex SHA', () => {
    expect(isValidSha('a'.repeat(40))).toBe(true);
    expect(isValidSha('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it('should reject empty string', () => {
    expect(isValidSha('')).toBe(false);
  });

  it('should reject short strings', () => {
    expect(isValidSha('abcdef')).toBe(false);
  });

  it('should reject strings with non-hex characters', () => {
    expect(isValidSha('g'.repeat(40))).toBe(false);
    expect(isValidSha('ABCDEF'.repeat(7).slice(0, 40))).toBe(false);
  });

  it('should reject strings longer than 40 chars', () => {
    expect(isValidSha('a'.repeat(41))).toBe(false);
  });
});

function makeStory(overrides: Partial<PrdStory> & { id: string }): PrdStory {
  return {
    actId: 'ACT-test',
    passes: false,
    notes: 'Source axis: correction',
    description: 'Resolve high finding in `src/foo.rs`: some issue',
    priority: 1,
    ...overrides,
  } as PrdStory;
}

describe('groupStoriesByAxisFile', () => {
  it('should group stories with same axis and file', () => {
    const stories = [
      makeStory({ id: 'FIX-001', priority: 1 }),
      makeStory({ id: 'FIX-002', priority: 2 }),
    ];
    const batches = groupStoriesByAxisFile(stories);
    expect(batches).toHaveLength(1);
    expect(batches[0].axis).toBe('correction');
    expect(batches[0].file).toBe('src/foo.rs');
    expect(batches[0].stories).toHaveLength(2);
  });

  it('should separate stories with different axes', () => {
    const stories = [
      makeStory({ id: 'FIX-001', notes: 'Source axis: correction' }),
      makeStory({ id: 'FIX-002', notes: 'Source axis: documentation' }),
    ];
    const batches = groupStoriesByAxisFile(stories);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.axis).sort()).toEqual(['correction', 'documentation']);
  });

  it('should separate stories with different files', () => {
    const stories = [
      makeStory({ id: 'FIX-001', description: 'Resolve in `src/a.rs`: issue' }),
      makeStory({ id: 'FIX-002', description: 'Resolve in `src/b.rs`: issue' }),
    ];
    const batches = groupStoriesByAxisFile(stories);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.file).sort()).toEqual(['src/a.rs', 'src/b.rs']);
  });

  it('should sort batches by lowest priority', () => {
    const stories = [
      makeStory({ id: 'FIX-010', priority: 10, description: 'Resolve in `src/b.rs`: issue' }),
      makeStory({ id: 'FIX-001', priority: 1, description: 'Resolve in `src/a.rs`: issue' }),
    ];
    const batches = groupStoriesByAxisFile(stories);
    expect(batches[0].file).toBe('src/a.rs');
    expect(batches[1].file).toBe('src/b.rs');
  });

  it('should handle stories with missing notes', () => {
    const stories = [
      makeStory({ id: 'FIX-001', notes: undefined }),
    ];
    const batches = groupStoriesByAxisFile(stories);
    expect(batches).toHaveLength(1);
    expect(batches[0].axis).toBe('');
  });

  it('should handle stories with missing description', () => {
    const stories = [
      makeStory({ id: 'FIX-001', description: undefined }),
    ];
    const batches = groupStoriesByAxisFile(stories);
    expect(batches).toHaveLength(1);
    expect(batches[0].file).toBe('');
  });

  it('should return empty array for no stories', () => {
    expect(groupStoriesByAxisFile([])).toEqual([]);
  });
});

describe('CircuitBreakerState transitions', () => {
  function makeCb(overrides: Partial<CircuitBreakerState> = {}): CircuitBreakerState {
    return {
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastProgressIteration: 0,
      lastGoodSha: 'a'.repeat(40),
      ...overrides,
    };
  }

  it('should track no-progress threshold', () => {
    const cb = makeCb();
    // Simulate iterations with no progress
    for (let i = 0; i < CB_NO_PROGRESS_THRESHOLD; i++) {
      cb.consecutiveNoProgress++;
    }
    expect(cb.consecutiveNoProgress).toBe(CB_NO_PROGRESS_THRESHOLD);
    expect(cb.consecutiveNoProgress >= CB_NO_PROGRESS_THRESHOLD).toBe(true);
  });

  it('should reset no-progress counter when progress is made', () => {
    const cb = makeCb({ consecutiveNoProgress: 2 });
    // Progress detected
    cb.consecutiveNoProgress = 0;
    cb.lastProgressIteration = 3;
    cb.lastGoodSha = 'b'.repeat(40);
    expect(cb.consecutiveNoProgress).toBe(0);
    expect(cb.lastGoodSha).toBe('b'.repeat(40));
  });

  it('should track same-error threshold', () => {
    const cb = makeCb();
    for (let i = 0; i < CB_SAME_ERROR_THRESHOLD; i++) {
      cb.consecutiveSameError++;
    }
    expect(cb.consecutiveSameError).toBe(CB_SAME_ERROR_THRESHOLD);
    expect(cb.consecutiveSameError >= CB_SAME_ERROR_THRESHOLD).toBe(true);
  });

  it('should reset error counter when no error and no progress', () => {
    const cb = makeCb({ consecutiveSameError: 3 });
    // No error, no progress → reset error counter
    cb.consecutiveSameError = 0;
    expect(cb.consecutiveSameError).toBe(0);
  });

  it('should only count errors when there is no progress', () => {
    const cb = makeCb({ consecutiveSameError: 2 });
    // Progress made but error also occurred → reset error counter (progress wins)
    cb.consecutiveSameError = 0;
    cb.consecutiveNoProgress = 0;
    expect(cb.consecutiveSameError).toBe(0);
  });

  it('should enter half-open warning at threshold minus 1', () => {
    const cb = makeCb({ consecutiveNoProgress: 2 });
    expect(cb.consecutiveNoProgress >= 2).toBe(true);
    expect(cb.consecutiveNoProgress < CB_NO_PROGRESS_THRESHOLD).toBe(true);
  });
});
