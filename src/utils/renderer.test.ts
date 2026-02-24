import { describe, it, expect } from 'vitest';
import {
  buildProgressBar,
  createRenderer,
  verdictColor,
} from './renderer.js';

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
});

describe('verdictColor', () => {
  it('should return the verdict string for all known verdicts', () => {
    // verdictColor adds chalk coloring; the raw text should still contain the verdict
    expect(verdictColor('CLEAN')).toContain('CLEAN');
    expect(verdictColor('NEEDS_REFACTOR')).toContain('NEEDS_REFACTOR');
    expect(verdictColor('CRITICAL')).toContain('CRITICAL');
  });

  it('should return unknown verdicts as-is', () => {
    expect(verdictColor('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('createRenderer (plain mode)', () => {
  it('should create a plain renderer with all methods', () => {
    const renderer = createRenderer({ plain: true, version: '1.0.0' });
    expect(renderer).toBeDefined();
    expect(renderer.start).toBeTypeOf('function');
    expect(renderer.updateProgress).toBeTypeOf('function');
    expect(renderer.addResult).toBeTypeOf('function');
    expect(renderer.incrementCounter).toBeTypeOf('function');
    expect(renderer.showCompletion).toBeTypeOf('function');
    expect(renderer.stop).toBeTypeOf('function');
    expect(renderer.updateWorkerSlot).toBeTypeOf('function');
    expect(renderer.clearWorkerSlot).toBeTypeOf('function');
  });

  it('should handle worker slot methods without error in plain mode', () => {
    const renderer = createRenderer({ plain: true, version: '1.0.0' });
    // These should be no-ops and not throw
    renderer.updateWorkerSlot(0, 'src/foo.ts');
    renderer.clearWorkerSlot(0);
  });
});
