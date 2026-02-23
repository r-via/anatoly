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
});
