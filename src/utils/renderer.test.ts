import { describe, it, expect } from 'vitest';
import {
  buildProgressBar,
  formatCounterRow,
  formatResultLine,
  truncatePath,
  createRenderer,
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

describe('formatCounterRow', () => {
  it('should format all counters in plain mode', () => {
    const row = formatCounterRow({ dead: 3, duplicate: 1, overengineering: 2, error: 0 }, false);
    expect(row).toContain('dead 3');
    expect(row).toContain('dup 1');
    expect(row).toContain('over 2');
    expect(row).toContain('err 0');
  });

  it('should handle all zeros', () => {
    const row = formatCounterRow({ dead: 0, duplicate: 0, overengineering: 0, error: 0 }, false);
    expect(row).toContain('dead 0');
    expect(row).toContain('err 0');
  });
});

describe('formatResultLine', () => {
  it('should format a CLEAN result in plain mode', () => {
    const line = formatResultLine('src-utils-helper.rev.md', 'CLEAN', undefined, false);
    expect(line).toContain('OK');
    expect(line).toContain('src-utils-helper.rev.md');
    expect(line).toContain('CLEAN');
  });

  it('should include findings suffix', () => {
    const line = formatResultLine('src-core-scanner.rev.md', 'NEEDS_REFACTOR', 'DEAD:2', false);
    expect(line).toContain('NEEDS_REFACTOR');
    expect(line).toContain('DEAD:2');
  });
});

describe('truncatePath', () => {
  it('should not truncate short paths', () => {
    expect(truncatePath('src/foo.ts', 30)).toBe('src/foo.ts');
  });

  it('should truncate long paths with ellipsis', () => {
    const long = 'src/very/deeply/nested/components/Button/index.tsx';
    const result = truncatePath(long, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toContain('...');
  });
});

describe('createRenderer (plain mode)', () => {
  it('should create a plain renderer', () => {
    const renderer = createRenderer({ plain: true, version: '1.0.0' });
    expect(renderer).toBeDefined();
    expect(renderer.start).toBeTypeOf('function');
    expect(renderer.updateProgress).toBeTypeOf('function');
    expect(renderer.addResult).toBeTypeOf('function');
    expect(renderer.incrementCounter).toBeTypeOf('function');
    expect(renderer.showCompletion).toBeTypeOf('function');
    expect(renderer.stop).toBeTypeOf('function');
  });
});
