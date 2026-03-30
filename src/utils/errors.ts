// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ERROR_CODES = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  LOCK_EXISTS: 'LOCK_EXISTS',
  SDK_TIMEOUT: 'SDK_TIMEOUT',
  SDK_ERROR: 'SDK_ERROR',
  ZOD_VALIDATION_FAILED: 'ZOD_VALIDATION_FAILED',
  TREE_SITTER_PARSE_ERROR: 'TREE_SITTER_PARSE_ERROR',
  WRITE_ERROR: 'WRITE_ERROR',
  NLP_SUMMARIZATION_FAILED: 'NLP_SUMMARIZATION_FAILED',
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
  SDK_TIMEOUT: 'try again — the file may be too large; consider splitting it',
  SDK_ERROR: 'Claude Code SDK query failed — check that claude CLI is available and responsive',
  ZOD_VALIDATION_FAILED: 'run with --verbose for detailed validation output',
  TREE_SITTER_PARSE_ERROR: 'ensure the file is valid TypeScript',
  WRITE_ERROR: 'check disk space and file permissions',
  FILE_NOT_FOUND: 'make sure you are running Anatoly from your project root',
  NLP_SUMMARIZATION_FAILED: 'NLP summarization LLM call failed — check provider config and API keys',
};

/**
 * Structured error class for user-facing Anatoly failures.
 *
 * Carries a machine-readable {@link ErrorCode}, a `recoverable` flag indicating
 * whether the operation can be retried, and an optional `hint` with an actionable
 * recovery step. When no explicit hint is provided, a default hint is resolved
 * from {@link DEFAULT_HINTS} based on the error code.
 */
export class AnatolyError extends Error {
  public readonly hint: string;
  /** Verbose payload (partial transcript, full stack, etc.) kept out of console output. */
  public readonly detail: string | undefined;

  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly recoverable: boolean,
    hint?: string,
    detail?: string,
  ) {
    super(message);
    this.name = 'AnatolyError';
    this.hint = hint ?? DEFAULT_HINTS[code] ?? '';
    this.detail = detail;
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
   * Excludes stack and detail to keep console output concise —
   * use {@link writeDump} to persist verbose diagnostics to disk.
   */
  toLogObject(): Record<string, unknown> {
    return {
      errorMessage: this.message,
      code: this.code,
      recoverable: this.recoverable,
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }

  /**
   * Write a dump file with the full error details (message, stack, detail).
   * Returns the absolute path to the written file, or `undefined` on failure.
   */
  writeDump(errorsDir: string, label: string): string | undefined {
    try {
      mkdirSync(errorsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeLabel = label.replace(/[/\\]/g, '__').slice(0, 180);
      const fileName = `${safeLabel}__${ts}.txt`;
      const filePath = join(errorsDir, fileName);
      const MAX_DUMP_BYTES = 64 * 1024; // 64 KB cap per dump file
      const detail = this.detail && this.detail.length > MAX_DUMP_BYTES
        ? this.detail.slice(0, MAX_DUMP_BYTES) + '\n…(truncated)'
        : this.detail;
      const sections = [
        `Code:    ${this.code}`,
        `Message: ${this.message}`,
        ...(this.hint ? [`Hint:    ${this.hint}`] : []),
        '',
        '--- stack trace ---',
        this.stack ?? '(no stack)',
        ...(detail ? ['', '--- detail ---', detail] : []),
      ];
      writeFileSync(filePath, sections.join('\n'));
      return filePath;
    } catch {
      return undefined;
    }
  }
}
