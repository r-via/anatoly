import { describe, it, expect } from 'vitest';
import { matchGlob } from './run.js';

describe('matchGlob', () => {
  it('should match exact paths', () => {
    expect(matchGlob('src/utils/helper.ts', 'src/utils/helper.ts')).toBe(true);
  });

  it('should match * wildcard (single segment)', () => {
    expect(matchGlob('src/utils/helper.ts', 'src/utils/*.ts')).toBe(true);
    expect(matchGlob('src/core/scanner.ts', 'src/utils/*.ts')).toBe(false);
  });

  it('should match ** wildcard (multiple segments)', () => {
    expect(matchGlob('src/utils/helper.ts', 'src/**')).toBe(true);
    expect(matchGlob('src/core/deep/nested.ts', 'src/**')).toBe(true);
    expect(matchGlob('tests/foo.ts', 'src/**')).toBe(false);
  });

  it('should match ? wildcard (single character)', () => {
    expect(matchGlob('src/a.ts', 'src/?.ts')).toBe(true);
    expect(matchGlob('src/ab.ts', 'src/?.ts')).toBe(false);
  });

  it('should match brace expansion', () => {
    expect(matchGlob('src/utils/foo.ts', 'src/{utils,core}/**')).toBe(true);
    expect(matchGlob('src/core/bar.ts', 'src/{utils,core}/**')).toBe(true);
    expect(matchGlob('src/hooks/baz.ts', 'src/{utils,core}/**')).toBe(false);
  });

  it('should escape regex special characters', () => {
    expect(matchGlob('src/foo.ts', 'src/foo.ts')).toBe(true);
    expect(matchGlob('src/fooxts', 'src/foo.ts')).toBe(false);
  });
});
