import { describe, it, expect } from 'vitest';
import {
  buildProgressBar,
  verdictColor,
  formatCounterRow,
  formatResultLine,
  type Counters,
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

describe('formatCounterRow', () => {
  it('should format all counter labels in plain mode', () => {
    const counters: Counters = { dead: 2, duplicate: 1, overengineering: 0, error: 3 };
    const result = formatCounterRow(counters, false);
    expect(result).toBe('dead 2  dup 1  over 0  err 3');
  });

  it('should format zero counters in plain mode', () => {
    const counters: Counters = { dead: 0, duplicate: 0, overengineering: 0, error: 0 };
    const result = formatCounterRow(counters, false);
    expect(result).toBe('dead 0  dup 0  over 0  err 0');
  });

  it('should include all labels with color', () => {
    const counters: Counters = { dead: 1, duplicate: 0, overengineering: 2, error: 0 };
    const result = formatCounterRow(counters, true);
    expect(result).toContain('dead');
    expect(result).toContain('dup');
    expect(result).toContain('over');
    expect(result).toContain('err');
  });
});

describe('formatResultLine', () => {
  it('should format a CLEAN verdict in plain mode', () => {
    const result = formatResultLine('src/foo.ts', 'CLEAN', undefined, false);
    expect(result).toBe('OK src/foo.ts  CLEAN');
  });

  it('should include findings suffix', () => {
    const result = formatResultLine('src/bar.ts', 'NEEDS_REFACTOR', '2 dead', false);
    expect(result).toBe('OK src/bar.ts  NEEDS_REFACTOR 2 dead');
  });

  it('should format CRITICAL verdict in plain mode', () => {
    const result = formatResultLine('src/baz.ts', 'CRITICAL', '1 err', false);
    expect(result).toBe('OK src/baz.ts  CRITICAL 1 err');
  });

  it('should contain verdict text with color enabled', () => {
    const result = formatResultLine('src/foo.ts', 'CLEAN', undefined, true);
    expect(result).toContain('CLEAN');
    expect(result).toContain('src/foo.ts');
  });
});

