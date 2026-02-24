import { describe, it, expect } from 'vitest';
import picomatch from 'picomatch';

describe('picomatch glob matching (replaces matchGlob)', () => {
  it('should match exact paths', () => {
    expect(picomatch.isMatch('src/utils/helper.ts', 'src/utils/helper.ts')).toBe(true);
  });

  it('should match * wildcard (single segment)', () => {
    expect(picomatch.isMatch('src/utils/helper.ts', 'src/utils/*.ts')).toBe(true);
    expect(picomatch.isMatch('src/core/scanner.ts', 'src/utils/*.ts')).toBe(false);
  });

  it('should match ** wildcard (multiple segments)', () => {
    expect(picomatch.isMatch('src/utils/helper.ts', 'src/**')).toBe(true);
    expect(picomatch.isMatch('src/core/deep/nested.ts', 'src/**')).toBe(true);
    expect(picomatch.isMatch('tests/foo.ts', 'src/**')).toBe(false);
  });

  it('should match ? wildcard (single character)', () => {
    expect(picomatch.isMatch('src/a.ts', 'src/?.ts')).toBe(true);
    expect(picomatch.isMatch('src/ab.ts', 'src/?.ts')).toBe(false);
  });

  it('should match brace expansion', () => {
    expect(picomatch.isMatch('src/utils/foo.ts', 'src/{utils,core}/**')).toBe(true);
    expect(picomatch.isMatch('src/core/bar.ts', 'src/{utils,core}/**')).toBe(true);
    expect(picomatch.isMatch('src/hooks/baz.ts', 'src/{utils,core}/**')).toBe(false);
  });

  it('should handle dots in file extensions', () => {
    expect(picomatch.isMatch('src/foo.ts', 'src/foo.ts')).toBe(true);
    expect(picomatch.isMatch('src/fooxts', 'src/foo.ts')).toBe(false);
  });
});
