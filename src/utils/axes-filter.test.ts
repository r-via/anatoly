import { describe, it, expect } from 'vitest';
import { parseAxesFilter } from './axes-filter.js';

describe('parseAxesFilter', () => {
  it('should return undefined when input is undefined', () => {
    expect(parseAxesFilter(undefined)).toBeUndefined();
  });

  it('should return undefined when input is empty string', () => {
    expect(parseAxesFilter('')).toBeUndefined();
  });

  it('should parse a single axis', () => {
    expect(parseAxesFilter('correction')).toEqual(['correction']);
  });

  it('should parse multiple comma-separated axes', () => {
    expect(parseAxesFilter('correction,tests')).toEqual(['correction', 'tests']);
  });

  it('should trim whitespace around axis names', () => {
    expect(parseAxesFilter(' correction , tests ')).toEqual(['correction', 'tests']);
  });

  it('should accept all valid axis IDs', () => {
    const all = 'utility,duplication,correction,overengineering,tests,best_practices';
    expect(parseAxesFilter(all)).toEqual([
      'utility', 'duplication', 'correction', 'overengineering', 'tests', 'best_practices',
    ]);
  });

  it('should throw for a single unknown axis', () => {
    expect(() => parseAxesFilter('foobar')).toThrow(
      /Unknown axis: foobar.*Valid axes:/,
    );
  });

  it('should throw for multiple unknown axes', () => {
    expect(() => parseAxesFilter('foobar,baz')).toThrow(
      /Unknown axes: foobar, baz.*Valid axes:/,
    );
  });

  it('should throw when mix of valid and invalid axes', () => {
    expect(() => parseAxesFilter('correction,foobar')).toThrow(
      /Unknown axis: foobar.*Valid axes:/,
    );
  });

  it('should ignore empty segments from trailing comma', () => {
    expect(parseAxesFilter('correction,')).toEqual(['correction']);
  });
});
