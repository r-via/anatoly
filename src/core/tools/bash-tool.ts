// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { execSync } from 'node:child_process';
import { z } from 'zod';

export interface BashToolOptions {
  /** Allow write operations. When false (default), only read commands are permitted. */
  allowWrite?: boolean;
  /** Working directory for command execution. */
  cwd?: string;
  /** Timeout in milliseconds (default: 30_000). */
  timeout?: number;
}

/** Patterns that are never allowed, even in write mode. */
const BLOCKED_PATTERNS = [/rm\s+-rf\s+\/\s*$/, /mkfs\b/, /\bdd\s+if=/, /:\(\)\s*\{/, /\bshutdown\b/, /\breboot\b/];

/** Command prefixes that imply write operations. */
const WRITE_PREFIXES = [
  'rm ', 'rmdir ', 'mv ', 'cp ', 'mkdir ',
  'touch ', 'chmod ', 'chown ', 'ln ',
  'tee ', 'truncate ', 'shred ',
  'git add', 'git commit', 'git push', 'git reset',
  'npm publish', 'npx ', 'npm run', 'yarn ',
];

/** Shell operators that imply write operations. */
const WRITE_OPERATORS = ['>', '>>', '|tee '];

/** Shell metacharacters that enable chaining/subshells — reject in read-only mode. */
const SHELL_METACHAR_RE = /[;`$]|\$\(|&&|\|\||{\s/;

function isWriteCommand(command: string): boolean {
  const trimmed = command.trim();
  // Reject shell metacharacters that could bypass prefix checks
  if (SHELL_METACHAR_RE.test(trimmed)) return true;
  for (const prefix of WRITE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  for (const op of WRITE_OPERATORS) {
    if (trimmed.includes(op)) return true;
  }
  return false;
}

function isDangerous(command: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(command));
}

export interface BashTool {
  description: string;
  parameters: z.ZodObject<{ command: z.ZodString }>;
  execute: (args: { command: string }) => Promise<string>;
}

/**
 * Create a Vercel AI SDK-compatible bash tool.
 *
 * In read-only mode (`allowWrite: false`, the default), write commands are rejected.
 * This is suitable for investigation agents that need to read source code.
 */
export function createBashTool(options: BashToolOptions = {}): BashTool {
  const { allowWrite = false, cwd, timeout = 30_000 } = options;

  const description = allowWrite
    ? 'Execute a bash command with read and write access to the filesystem.'
    : 'Execute a read-only bash command. Use this to read files (cat, head, tail), search (grep, find, ls), and inspect the codebase. Write operations are blocked.';

  return {
    description,
    parameters: z.object({
      command: z.string().describe('The bash command to execute'),
    }),
    execute: async ({ command }: { command: string }) => {
      if (isDangerous(command)) {
        throw new Error(`Blocked dangerous command: ${command}`);
      }
      if (!allowWrite && isWriteCommand(command)) {
        throw new Error(`Command rejected in read-only mode: ${command}`);
      }

      try {
        const stdout = execSync(command, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024, // 1MB
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return stdout;
      } catch (err: unknown) {
        const execErr = err as { stderr?: string; status?: number; message?: string };
        const stderr = execErr.stderr ?? '';
        const status = execErr.status ?? 1;
        return `Command failed (exit ${status}):\n${stderr || execErr.message}`;
      }
    },
  };
}
