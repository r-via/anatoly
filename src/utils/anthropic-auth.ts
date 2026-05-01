// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { execFileSync } from 'node:child_process';

/**
 * Result of an Anthropic auth probe.
 */
export interface AnthropicAuthResult {
  ok: boolean;
  /** When ok=false, a short reason for the user. */
  reason?: string;
  /** When ok=true and we could read it, the Claude Code CLI version string. */
  claudeVersion?: string;
}

/**
 * Verify that the Anthropic provider is usable in the configured mode.
 *
 * For `subscription` mode, the Claude Agent SDK spawns the `claude` CLI
 * (Claude Code) under the hood. We probe by invoking `claude --version`,
 * which is a free, fast call that returns 0 only when the binary is
 * installed and runnable. This catches the most common failure on fresh
 * machines: the user installed `@r-via/anatoly` but never installed
 * Claude Code itself, and the run would otherwise fail silently in the
 * first axis evaluator with an obscure "spawn failed" error.
 *
 * For `api` mode, we only need an API key in the environment.
 */
export function checkAnthropicAuth(mode: 'subscription' | 'api'): AnthropicAuthResult {
  if (mode === 'api') {
    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        ok: false,
        reason: 'ANTHROPIC_API_KEY is not set in the environment',
      };
    }
    return { ok: true };
  }

  // subscription — probe the claude CLI
  try {
    const out = execFileSync('claude', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, claudeVersion: out };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason: 'the `claude` CLI (Claude Code) was not found on PATH',
      };
    }
    return {
      ok: false,
      reason: `running \`claude --version\` failed: ${(err as Error).message}`,
    };
  }
}
