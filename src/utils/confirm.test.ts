import { describe, it, expect, vi, afterEach } from 'vitest';
import { isInteractive, confirm } from './confirm.js';
import { createInterface } from 'node:readline';

vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

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

  describe('confirm', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return true when user answers "y"', async () => {
      const mockRl = { question: vi.fn(), close: vi.fn() };
      mockRl.question.mockImplementation((_msg: string, cb: (answer: string) => void) => cb('y'));
      vi.mocked(createInterface).mockReturnValue(mockRl as never);

      const result = await confirm('Proceed?');
      expect(result).toBe(true);
      expect(mockRl.close).toHaveBeenCalled();
    });

    it('should return true when user answers "Y"', async () => {
      const mockRl = { question: vi.fn(), close: vi.fn() };
      mockRl.question.mockImplementation((_msg: string, cb: (answer: string) => void) => cb('Y'));
      vi.mocked(createInterface).mockReturnValue(mockRl as never);

      const result = await confirm('Proceed?');
      expect(result).toBe(true);
    });

    it('should return false when user answers "n"', async () => {
      const mockRl = { question: vi.fn(), close: vi.fn() };
      mockRl.question.mockImplementation((_msg: string, cb: (answer: string) => void) => cb('n'));
      vi.mocked(createInterface).mockReturnValue(mockRl as never);

      const result = await confirm('Proceed?');
      expect(result).toBe(false);
    });

    it('should return false when user presses enter (empty)', async () => {
      const mockRl = { question: vi.fn(), close: vi.fn() };
      mockRl.question.mockImplementation((_msg: string, cb: (answer: string) => void) => cb(''));
      vi.mocked(createInterface).mockReturnValue(mockRl as never);

      const result = await confirm('Proceed?');
      expect(result).toBe(false);
    });

    it('should include [y/N] in the prompt', async () => {
      const mockRl = { question: vi.fn(), close: vi.fn() };
      mockRl.question.mockImplementation((_msg: string, cb: (answer: string) => void) => cb('n'));
      vi.mocked(createInterface).mockReturnValue(mockRl as never);

      await confirm('Proceed?');
      expect(mockRl.question).toHaveBeenCalledWith('Proceed? [y/N] ', expect.any(Function));
    });
  });
});
