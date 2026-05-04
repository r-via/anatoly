// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  buildProgressBar,
  verdictColor,
  formatCompactTokens,
} from './format.js';

describe('buildProgressBar', () => {
  it('should render full bar when complete', () => {
    const bar = buildProgressBar(10, 10, 10);
    expect(bar).toBe('██████████');
  });

  it('should render empty bar when at zero', () => {
    const bar = buildProgressBar(0, 10, 10);
    expect(bar).toBe('░░░░░░░░░░');
  });

  it('should render half bar', () => {
    const bar = buildProgressBar(5, 10, 10);
    expect(bar).toBe('█████░░░░░');
  });

  it('should handle total of zero', () => {
    const bar = buildProgressBar(0, 0, 10);
    expect(bar).toBe('░░░░░░░░░░');
  });

  it('should clamp ratio above 1', () => {
    const bar = buildProgressBar(15, 10, 10);
    expect(bar).toBe('██████████');
  });
});

describe('verdictColor', () => {
  it('should return the verdict string for all known verdicts', () => {
    expect(verdictColor('CLEAN')).toContain('CLEAN');
    expect(verdictColor('NEEDS_REFACTOR')).toContain('NEEDS_REFACTOR');
    expect(verdictColor('CRITICAL')).toContain('CRITICAL');
  });

  it('should return unknown verdicts as-is', () => {
    expect(verdictColor('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('formatCompactTokens', () => {
  it('renders raw number under 1K', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(999)).toBe('999');
  });

  it('renders one decimal between 1K and 10K', () => {
    expect(formatCompactTokens(1_000)).toBe('1.0K');
    expect(formatCompactTokens(1_500)).toBe('1.5K');
    expect(formatCompactTokens(9_999)).toBe('10.0K');
  });

  it('renders rounded thousands between 10K and 1M', () => {
    expect(formatCompactTokens(58_000)).toBe('58K');
    expect(formatCompactTokens(72_400)).toBe('72K');
    expect(formatCompactTokens(999_999)).toBe('1000K');
  });

  it('renders one decimal for 1M and above', () => {
    expect(formatCompactTokens(1_000_000)).toBe('1.0M');
    expect(formatCompactTokens(1_500_000)).toBe('1.5M');
    expect(formatCompactTokens(12_345_678)).toBe('12.3M');
  });
});
