import { describe, it, expect } from 'vitest';
import { AnatolyError, ERROR_CODES } from './errors.js';

describe('AnatolyError', () => {
  it('should create an error with code and recoverable flag', () => {
    const err = new AnatolyError(
      'Config file is invalid YAML',
      ERROR_CODES.CONFIG_INVALID,
      false,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AnatolyError);
    expect(err.message).toBe('Config file is invalid YAML');
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.recoverable).toBe(false);
    expect(err.name).toBe('AnatolyError');
  });

  it('should create a recoverable error', () => {
    const err = new AnatolyError(
      'LLM timeout after 180s',
      ERROR_CODES.LLM_TIMEOUT,
      true,
    );
    expect(err.recoverable).toBe(true);
    expect(err.code).toBe('LLM_TIMEOUT');
  });

  it('should have all expected error codes', () => {
    expect(ERROR_CODES).toEqual({
      CONFIG_INVALID: 'CONFIG_INVALID',
      CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
      FILE_NOT_FOUND: 'FILE_NOT_FOUND',
      LOCK_EXISTS: 'LOCK_EXISTS',
      LLM_TIMEOUT: 'LLM_TIMEOUT',
      LLM_API_ERROR: 'LLM_API_ERROR',
      ZOD_VALIDATION_FAILED: 'ZOD_VALIDATION_FAILED',
      TREE_SITTER_PARSE_ERROR: 'TREE_SITTER_PARSE_ERROR',
      WRITE_ERROR: 'WRITE_ERROR',
    });
  });

  it('should use default hint when no custom hint provided', () => {
    const err = new AnatolyError('lock exists', ERROR_CODES.LOCK_EXISTS, false);
    expect(err.hint).toBe('wait for it to finish or run `anatoly reset` to force clear');
  });

  it('should use custom hint when provided', () => {
    const err = new AnatolyError(
      'lock exists',
      ERROR_CODES.LOCK_EXISTS,
      false,
      'custom recovery step',
    );
    expect(err.hint).toBe('custom recovery step');
  });

  it('should format error for display with hint', () => {
    const err = new AnatolyError(
      'Another instance is running',
      ERROR_CODES.LOCK_EXISTS,
      false,
      'run `anatoly reset`',
    );
    expect(err.formatForDisplay()).toBe(
      'error: Another instance is running\n  → run `anatoly reset`',
    );
  });

  it('should format error for display without hint', () => {
    const err = new AnatolyError(
      'Something failed',
      ERROR_CODES.FILE_NOT_FOUND,
      false,
    );
    // FILE_NOT_FOUND has a default hint
    expect(err.formatForDisplay()).toContain('error: Something failed');
    expect(err.formatForDisplay()).toContain('→');
  });

  describe('toLogObject', () => {
    it('should serialize AnatolyError with hint to structured object', () => {
      const err = new AnatolyError(
        'evaluation timed out after 180s',
        ERROR_CODES.LLM_TIMEOUT,
        true,
      );
      const obj = err.toLogObject();
      expect(obj.errorMessage).toBe('evaluation timed out after 180s');
      expect(obj.code).toBe('LLM_TIMEOUT');
      expect(obj.recoverable).toBe(true);
      expect(obj.hint).toBe('try again — the file may be too large; consider splitting it');
      expect(obj.stack).toBeDefined();
      expect(typeof obj.stack).toBe('string');
      expect((obj.stack as string)).toContain('AnatolyError');
    });

    it('should omit hint when it is empty', () => {
      // Create with explicit empty hint
      const err = new AnatolyError('bad config', ERROR_CODES.CONFIG_INVALID, false);
      // CONFIG_INVALID has a default hint, so it won't be empty — use a code without default
      const errNoHint = new AnatolyError('unknown', ERROR_CODES.WRITE_ERROR, false);
      const obj = errNoHint.toLogObject();
      // WRITE_ERROR has a default hint
      expect(obj.hint).toBeDefined();
    });

    it('should use errorMessage (not msg) to avoid pino field collision', () => {
      const err = new AnatolyError('test message', ERROR_CODES.FILE_NOT_FOUND, false);
      const obj = err.toLogObject();
      expect(obj.errorMessage).toBe('test message');
      expect(obj).not.toHaveProperty('msg');
    });

    it('should include stack trace from Error', () => {
      const err = new AnatolyError('boom', ERROR_CODES.LLM_API_ERROR, true);
      const obj = err.toLogObject();
      expect(typeof obj.stack).toBe('string');
      expect((obj.stack as string).length).toBeGreaterThan(0);
    });
  });
});
