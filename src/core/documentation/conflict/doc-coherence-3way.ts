// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * 3-way coherence review helpers — Story 54.8
 *
 * Builds the CODE_SURFACE summary from scanned tasks and assembles the
 * user message with REFERENCE_DOCS, INTERNAL_DOCS, and CODE_SURFACE
 * input blocks for the coherence review agent.
 */

import { resolve, sep } from 'node:path';
import type { Task } from '../../../schemas/task.js';
import type { ReferenceDoc } from '../../reference-docs-resolver.js';

// ---------------------------------------------------------------------------
// Code surface builder
// ---------------------------------------------------------------------------

/**
 * Build a concise markdown summary of the project's public API surface
 * from scanned tasks. Only exported symbols are included.
 */
export function buildCodeSurfaceSummary(tasks: Task[]): string {
  const sorted = [...tasks].sort((a, b) => a.file.localeCompare(b.file));
  const lines: string[] = [];
  let hasExports = false;

  for (const t of sorted) {
    const exported = t.symbols.filter((s) => s.exported);
    if (exported.length === 0) continue;
    hasExports = true;
    lines.push(`### ${t.file}`);
    for (const s of exported) {
      lines.push(`- ${s.kind} \`${s.name}\` (L${s.line_start}–L${s.line_end})`);
    }
    lines.push('');
  }

  if (!hasExports) {
    return '_No exported symbols found in the scanned project._';
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

export interface CoherenceUserMessageOpts {
  /** Internal docs content (already formatted as <file> blocks or file listing). */
  internalDocsContent: string;
  /** Human-authored reference docs (optional). */
  referenceDocs?: ReferenceDoc[];
  /** Code surface summary string (optional). */
  codeSurface?: string;
  /** Linter issues to include (optional). */
  linterIssues?: Array<{ path: string; rule: string; detail: string }>;
  /** Whether content was injected inline (true) or needs Read tool (false). */
  contentInjected?: boolean;
  /** Total file count for display. */
  fileCount?: number;
}

/**
 * Build the user message for the 3-way coherence review agent.
 *
 * Sections are emitted in order:
 * 1. REFERENCE_DOCS (if provided) — authoritative human-authored docs
 * 2. CODE_SURFACE (if provided) — public API summary from scanner
 * 3. INTERNAL_DOCS — the generated docs being reviewed
 * 4. Linter issues (if any)
 */
export function buildCoherenceUserMessage(opts: CoherenceUserMessageOpts): string {
  const parts: string[] = [];

  // 1. Reference docs
  if (opts.referenceDocs && opts.referenceDocs.length > 0) {
    parts.push('## REFERENCE_DOCS');
    parts.push('');
    parts.push('These are human-authored reference documents. They are **authoritative ground truth**.');
    parts.push('If an internal doc contradicts a reference doc, the reference wins.');
    parts.push('');
    for (const doc of opts.referenceDocs) {
      const label = doc.symbol
        ? `### \`${doc.path}\` (${doc.source}, symbol: ${doc.symbol})`
        : `### \`${doc.path}\` (${doc.source})`;
      parts.push(label);
      parts.push('');
      parts.push(doc.content);
      parts.push('');
    }
  }

  // 2. Code surface
  if (opts.codeSurface) {
    parts.push('## CODE_SURFACE');
    parts.push('');
    parts.push('Public API surface extracted from source code. Use this to verify factual claims in internal docs.');
    parts.push('');
    parts.push(opts.codeSurface);
    parts.push('');
  }

  // 3. Internal docs
  parts.push('## INTERNAL_DOCS');
  parts.push('');
  if (opts.contentInjected !== false) {
    parts.push(
      `Below are the internal documentation files to review.`,
      `Fix any coherence issues using the Write tool.`,
    );
  } else {
    parts.push(
      `The documentation directory is your current working directory.`,
      `Please read all pages, identify coherence issues, and fix them.`,
    );
  }
  parts.push('');
  parts.push(opts.internalDocsContent);

  // 4. Linter issues
  if (opts.linterIssues && opts.linterIssues.length > 0) {
    parts.push('');
    parts.push('## Known structural issues (from linter)');
    parts.push('');
    for (const i of opts.linterIssues) {
      parts.push(`- **${i.path}**: [${i.rule}] ${i.detail}`);
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Path guard
// ---------------------------------------------------------------------------

/**
 * Regression guard: verify that a write path targets the internal docs
 * directory. Throws if the resolved path escapes the allowed directory.
 *
 * @param writePath - The path the agent wants to write to.
 * @param allowedDir - The absolute path to the internal docs directory.
 * @throws Error if the path is outside the allowed directory.
 */
export function assertCoherenceWritePath(writePath: string, allowedDir: string): void {
  const resolved = resolve(writePath);
  const allowed = resolve(allowedDir);

  if (!resolved.startsWith(allowed + sep) && resolved !== allowed) {
    throw new Error(
      `COHERENCE GUARD VIOLATION: Write path "${writePath}" resolves to "${resolved}" ` +
      `which is outside the allowed directory "${allowed}". ` +
      `The coherence review agent can ONLY write files within .anatoly/docs/.`,
    );
  }
}
