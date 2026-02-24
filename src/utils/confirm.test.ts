import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isInteractive } from './confirm.js';

describe('confirm utilities', () => {
  describe('isInteractive', () => {
    const originalIsTTY = process.stdin.isTTY;

    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true });
    });

    it('should return true when stdin is a TTY', () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
      expect(isInteractive()).toBe(true);
    });

    it('should return false when stdin is not a TTY', () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });
      expect(isInteractive()).toBe(false);
    });
  });
});
