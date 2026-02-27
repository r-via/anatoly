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

/**
 * Default recovery hints per error code.
 * Each hint is a short, actionable next step for the user.
 */
const DEFAULT_HINTS: Partial<Record<ErrorCode, string>> = {
  LOCK_EXISTS: 'wait for it to finish or run `anatoly reset` to force clear',
  CONFIG_INVALID: 'check .anatoly.yml syntax and refer to documentation',
  CONFIG_NOT_FOUND: 'create a .anatoly.yml or run without --config',
  LLM_TIMEOUT: 'try again — the file may be too large; consider splitting it',
  LLM_API_ERROR: 'check your ANTHROPIC_API_KEY and network connectivity',
  ZOD_VALIDATION_FAILED: 'run with --verbose for detailed validation output',
  TREE_SITTER_PARSE_ERROR: 'ensure the file is valid TypeScript',
  WRITE_ERROR: 'check disk space and file permissions',
  FILE_NOT_FOUND: 'make sure you are running Anatoly from your project root',
};

export class AnatolyError extends Error {
  public readonly hint: string;

  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean,
    hint?: string,
  ) {
    super(message);
    this.name = 'AnatolyError';
    this.hint = hint ?? DEFAULT_HINTS[code] ?? '';
  }

  /**
   * Format the error for terminal display:
   *   error: <message>
   *     → <recovery step>
   */
  formatForDisplay(): string {
    const lines = [`error: ${this.message}`];
    if (this.hint) {
      lines.push(`  → ${this.hint}`);
    }
    return lines.join('\n');
  }

  /**
   * Serialize to a structured object suitable for pino log fields.
   * Uses `errorMessage` (not `msg`) to avoid collision with pino's own `msg` field.
   */
  toLogObject(): Record<string, unknown> {
    return {
      errorMessage: this.message,
      code: this.code,
      recoverable: this.recoverable,
      ...(this.hint ? { hint: this.hint } : {}),
      stack: this.stack,
    };
  }
}
