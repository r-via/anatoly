/**
 * Unit tests for the RAG evaluation framework.
 *
 * Tests the ground-truth fixture definitions and metrics computation
 * using mock embeddings. This validates the evaluation logic without
 * requiring actual model inference.
 */

import { describe, it, expect } from 'vitest';
import {
  EVAL_FUNCTIONS,
  buildGroundTruth,
  pairKey,
} from '../../scripts/fixtures/eval-functions.js';

describe('eval-functions fixtures', () => {
  it('should have 15 functions', () => {
    expect(EVAL_FUNCTIONS).toHaveLength(15);
  });

  it('should have unique IDs', () => {
    const ids = EVAL_FUNCTIONS.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have 5 duplicate groups with 2 functions each', () => {
    const groups = new Map<string, number>();
    for (const fn of EVAL_FUNCTIONS) {
      groups.set(fn.group, (groups.get(fn.group) ?? 0) + 1);
    }

    const dupGroups = [...groups.entries()].filter(([g]) => !g.startsWith('unique-'));
    expect(dupGroups).toHaveLength(5);
    for (const [, count] of dupGroups) {
      expect(count).toBe(2);
    }
  });

  it('should have 5 unique (singleton) groups', () => {
    const groups = new Map<string, number>();
    for (const fn of EVAL_FUNCTIONS) {
      groups.set(fn.group, (groups.get(fn.group) ?? 0) + 1);
    }

    const uniqueGroups = [...groups.entries()].filter(([g]) => g.startsWith('unique-'));
    expect(uniqueGroups).toHaveLength(5);
    for (const [, count] of uniqueGroups) {
      expect(count).toBe(1);
    }
  });

  it('each function should have non-empty source code', () => {
    for (const fn of EVAL_FUNCTIONS) {
      expect(fn.source.trim().length).toBeGreaterThan(10);
    }
  });
});

describe('buildGroundTruth', () => {
  it('should produce exactly 5 ground-truth duplicate pairs', () => {
    const gt = buildGroundTruth();
    expect(gt.size).toBe(5);
  });

  it('should contain the expected pairs', () => {
    const gt = buildGroundTruth();
    expect(gt.has(pairKey('fetchUserAxios', 'getUserFetch'))).toBe(true);
    expect(gt.has(pairKey('deduplicateSet', 'removeDuplicates'))).toBe(true);
    expect(gt.has(pairKey('retryPromise', 'exponentialRetry'))).toBe(true);
    expect(gt.has(pairKey('memoizeFunction', 'withCache'))).toBe(true);
    expect(gt.has(pairKey('createLogger', 'buildLogger'))).toBe(true);
  });

  it('should NOT contain cross-group pairs', () => {
    const gt = buildGroundTruth();
    expect(gt.has(pairKey('fetchUserAxios', 'retryPromise'))).toBe(false);
    expect(gt.has(pairKey('parseMarkdown', 'validateEmail'))).toBe(false);
    expect(gt.has(pairKey('memoizeFunction', 'debounce'))).toBe(false);
  });
});

describe('pairKey', () => {
  it('should produce canonical ordering', () => {
    expect(pairKey('a', 'b')).toBe('a::b');
    expect(pairKey('b', 'a')).toBe('a::b');
  });

  it('should be consistent regardless of argument order', () => {
    expect(pairKey('fetchUserAxios', 'getUserFetch')).toBe(
      pairKey('getUserFetch', 'fetchUserAxios'),
    );
  });
});

describe('metrics computation (simulated)', () => {
  // Simulate a perfect classifier to test metric formulas
  it('should compute perfect precision/recall with clean separation', () => {
    const gt = buildGroundTruth();
    const n = EVAL_FUNCTIONS.length;
    const totalPairs = (n * (n - 1)) / 2; // C(15, 2) = 105

    // Perfect classifier: duplicates get score 0.9, non-duplicates get 0.3
    interface Pair { score: number; isDuplicate: boolean }
    const pairs: Pair[] = [];
    for (let i = 0; i < EVAL_FUNCTIONS.length; i++) {
      for (let j = i + 1; j < EVAL_FUNCTIONS.length; j++) {
        const key = pairKey(EVAL_FUNCTIONS[i].id, EVAL_FUNCTIONS[j].id);
        const isDuplicate = gt.has(key);
        pairs.push({ score: isDuplicate ? 0.9 : 0.3, isDuplicate });
      }
    }

    expect(pairs).toHaveLength(totalPairs); // 105 pairs
    expect(pairs.filter(p => p.isDuplicate)).toHaveLength(5);

    // At threshold 0.5: all 5 duplicates detected, 0 false positives
    const threshold = 0.5;
    let tp = 0, fp = 0, fn = 0;
    for (const p of pairs) {
      const predicted = p.score >= threshold;
      if (predicted && p.isDuplicate) tp++;
      if (predicted && !p.isDuplicate) fp++;
      if (!predicted && p.isDuplicate) fn++;
    }

    expect(tp).toBe(5);
    expect(fp).toBe(0);
    expect(fn).toBe(0);

    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    const f1 = (2 * precision * recall) / (precision + recall);

    expect(precision).toBe(1.0);
    expect(recall).toBe(1.0);
    expect(f1).toBe(1.0);
  });

  it('should detect when recall drops at high thresholds', () => {
    const gt = buildGroundTruth();

    // Mixed classifier: 3 duplicates score high, 2 score low
    interface Pair { score: number; isDuplicate: boolean }
    const pairs: Pair[] = [];
    let dupIndex = 0;
    for (let i = 0; i < EVAL_FUNCTIONS.length; i++) {
      for (let j = i + 1; j < EVAL_FUNCTIONS.length; j++) {
        const key = pairKey(EVAL_FUNCTIONS[i].id, EVAL_FUNCTIONS[j].id);
        const isDuplicate = gt.has(key);
        let score: number;
        if (isDuplicate) {
          score = dupIndex < 3 ? 0.85 : 0.55; // 3 easy, 2 hard
          dupIndex++;
        } else {
          score = 0.3;
        }
        pairs.push({ score, isDuplicate });
      }
    }

    // At threshold 0.75: only 3 duplicates detected
    const threshold = 0.75;
    let tp = 0, fn = 0;
    for (const p of pairs) {
      const predicted = p.score >= threshold;
      if (predicted && p.isDuplicate) tp++;
      if (!predicted && p.isDuplicate) fn++;
    }

    expect(tp).toBe(3);
    expect(fn).toBe(2);

    const recall = tp / (tp + fn);
    expect(recall).toBe(0.6); // 3/5
  });
});
