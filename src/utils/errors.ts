export const ERROR_CODES = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  LOCK_EXISTS: 'LOCK_EXISTS',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_API_ERROR: 'LLM_API_ERROR',
  ZOD_VALIDATION_FAILED: 'ZOD_VALIDATION_FAILED',
  TREE_SITTER_PARSE_ERROR: 'TREE_SITTER_PARSE_ERROR',
  WRITE_ERROR: 'WRITE_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AnatolyError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'AnatolyError';
  }
}
