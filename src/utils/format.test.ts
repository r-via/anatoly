import { describe, it, expect } from 'vitest';
import {
  buildProgressBar,
  verdictColor,
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
