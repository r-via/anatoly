// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogContext } from '../../utils/log-context.js';

/**
 * Build the 4-segment dump slug from the active ALS context:
 * `{phase}__{composer}__{primitive}__{callId}`.
 *
 * Throws if any required field is missing (the runtime always opens the
 * scope before invoking transports).
 */
export function buildDumpSlug(): string {
  const ctx = getLogContext();
  const missing: string[] = [];
  if (!ctx?.phase) missing.push('phase');
  if (!ctx?.composer) missing.push('composer');
  if (!ctx?.primitive) missing.push('primitive');
  if (!ctx?.callId) missing.push('callId');

  if (missing.length > 0) {
    throw new Error(
      `buildDumpSlug: missing ALS scope fields: ${missing.join(', ')}` +
        ` (have: phase=${ctx?.phase}, composer=${ctx?.composer},` +
        ` primitive=${ctx?.primitive}, callId=${ctx?.callId})`,
    );
  }

  return `${ctx!.phase}__${ctx!.composer}__${ctx!.primitive}__${ctx!.callId}`;
}

/** Active conversation dump handle. */
export interface ConvDump {
  path: string;
  fileName: string;
}

/**
 * Initialize a conversation dump file with header (system + user prompt).
 * Returns a handle for subsequent appends, or undefined if setup fails.
 *
 * doc 19 PR 3: the dump prefix is derived from the active ALS log-context
 * by {@link buildDumpSlug}, not supplied by the caller. Transports pass
 * only the conversation directory and the attempt number.
 */
export function initConvDump(opts: {
  conversationDir: string;
  attempt: number;
  model: string;
  provider: string;
  systemPrompt?: string;
  userMessage: string;
}): ConvDump | undefined {
  try {
    mkdirSync(opts.conversationDir, { recursive: true });
    const prefix = buildDumpSlug();
    const suffix = `__${opts.attempt}.md`;
    const rawName = `${prefix}${suffix}`;
    const fileName = rawName.length > 250
      ? prefix.slice(0, 250 - suffix.length) + suffix
      : rawName;
    const path = join(opts.conversationDir, fileName);

    const title = prefix.replace(/__/g, ' — ');
    let header = `# Conversation: ${title} (attempt ${opts.attempt})\n\n`;
    header += `| Field | Value |\n|-------|-------|\n`;
    header += `| Model | ${opts.model} |\n`;
    header += `| Provider | ${opts.provider} |\n`;
    header += `| Timestamp | ${new Date().toISOString()} |\n\n---\n\n`;
    if (opts.systemPrompt) {
      header += `## System\n\n${opts.systemPrompt}\n\n---\n\n`;
    }
    header += `## User\n\n${opts.userMessage}\n\n---\n\n`;
    writeFileSync(path, header);

    return { path, fileName };
  } catch {
    return undefined;
  }
}

/** Append an assistant response to the conversation dump. */
export function appendAssistant(dump: ConvDump, text: string): void {
  try {
    appendFileSync(dump.path, `## Assistant\n\n${text}\n\n---\n\n`);
  } catch {
    // non-critical
  }
}

/** Append final metrics to the conversation dump. */
export function appendResult(dump: ConvDump, metrics: {
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheHitRate?: number;
  success: boolean;
}): void {
  try {
    let result = `## Result\n\n`;
    result += `| Field | Value |\n|-------|-------|\n`;
    result += `| Duration | ${(metrics.durationMs / 1000).toFixed(1)}s |\n`;
    result += `| Cost | $${metrics.costUsd.toFixed(4)} |\n`;
    result += `| Input tokens | ${metrics.inputTokens} |\n`;
    result += `| Output tokens | ${metrics.outputTokens} |\n`;
    if (metrics.cacheReadTokens != null) {
      result += `| Cache read | ${metrics.cacheReadTokens} |\n`;
    }
    if (metrics.cacheCreationTokens != null) {
      result += `| Cache creation | ${metrics.cacheCreationTokens} |\n`;
    }
    if (metrics.cacheHitRate != null) {
      result += `| Cache hit rate | ${Math.round(metrics.cacheHitRate * 100)}% |\n`;
    }
    result += `| Success | ${metrics.success} |\n`;
    appendFileSync(dump.path, result);
  } catch {
    // non-critical
  }
}

/** Append an error to the conversation dump. */
export function appendError(dump: ConvDump, err: unknown): void {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    appendFileSync(dump.path, `## Error\n\n\`\`\`\n${msg}\n\`\`\`\n`);
  } catch {
    // non-critical
  }
}
