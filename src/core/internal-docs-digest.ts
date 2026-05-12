// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../schemas/task.js';
import type { ReferenceDoc } from './reference-docs-resolver.js';
import type { Config } from '../schemas/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestResult {
  tokens: number;
  content: string;
  fingerprint: string;
}

interface CachedDigest extends DigestResult {
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Cheap heuristic: ~4 chars per token (cl100k_base average). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 fingerprint from the serialised inputs.
 * Inputs: sorted task hashes, sorted reference doc paths, and lite config.
 */
function computeFingerprint(tasks: Task[], referenceDocs: ReferenceDoc[], config: Config): string {
  const h = createHash('sha256');
  // Task hashes sorted by file path for determinism
  const sortedTasks = [...tasks].sort((a, b) => a.file.localeCompare(b.file));
  for (const t of sortedTasks) {
    h.update(`${t.file}:${t.hash}\n`);
  }
  // Reference doc paths sorted
  const sortedRefs = [...referenceDocs].sort((a, b) => a.path.localeCompare(b.path));
  for (const r of sortedRefs) {
    h.update(`ref:${r.path}:${r.source}\n`);
  }
  // Config signature
  const maxTokens = config.documentation?.internal?.lite?.max_tokens ?? 4000;
  h.update(`max_tokens:${maxTokens}\n`);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildModulesSection(tasks: Task[]): string {
  if (tasks.length === 0) return '## Modules\n\n_No modules detected._\n';
  const sorted = [...tasks].sort((a, b) => a.file.localeCompare(b.file));
  const lines = ['## Modules', ''];
  for (const t of sorted) {
    const lang = t.language ? ` (${t.language})` : '';
    lines.push(`- \`${t.file}\`${lang}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildPublicSurfaceSection(tasks: Task[]): string {
  const lines = ['## Public surface', ''];
  const sorted = [...tasks].sort((a, b) => a.file.localeCompare(b.file));
  let hasExports = false;
  for (const t of sorted) {
    const exported = t.symbols.filter((s) => s.exported);
    if (exported.length === 0) continue;
    hasExports = true;
    lines.push(`### \`${t.file}\``);
    lines.push('');
    for (const s of exported) {
      lines.push(`- ${s.kind} \`${s.name}\` (L${s.line_start}–L${s.line_end})`);
    }
    lines.push('');
  }
  if (!hasExports) {
    lines.push('_No exported symbols found._');
    lines.push('');
  }
  return lines.join('\n');
}

function buildReferenceIndexSection(referenceDocs: ReferenceDoc[]): string {
  // Only list non-comment reference docs (md, readme, spec)
  const mdDocs = referenceDocs.filter((d) => d.source !== 'comment');
  const lines = ['## Reference index', ''];
  if (mdDocs.length === 0) {
    lines.push('_No reference documents found._');
  } else {
    for (const d of mdDocs) {
      lines.push(`- \`${d.path}\` (${d.source})`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function buildInlineDocCommentsSection(referenceDocs: ReferenceDoc[]): string {
  const comments = referenceDocs.filter((d) => d.source === 'comment');
  const lines = ['## Inline doc-comments', ''];
  if (comments.length === 0) {
    lines.push('_No inline doc-comments found._');
  } else {
    for (const c of comments) {
      const header = c.symbol ? `### \`${c.symbol}\`` : `### \`${c.path}\``;
      lines.push(header);
      lines.push('');
      lines.push(c.content);
      lines.push('');
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate sections to fit within maxTokens.
 * Priority (keep first): Reference index > Inline doc-comments > Public surface > Modules
 * Returns the final assembled markdown + a truncation footer if needed.
 */
function truncateToFit(
  modulesSection: string,
  publicSurfaceSection: string,
  referenceIndexSection: string,
  docCommentsSection: string,
  maxTokens: number,
): { content: string; droppedEntries: number } {
  // Sections in priority order (highest first = last to be dropped)
  const sections = [
    { name: 'reference-index', text: referenceIndexSection },
    { name: 'doc-comments', text: docCommentsSection },
    { name: 'public-surface', text: publicSurfaceSection },
    { name: 'modules', text: modulesSection },
  ];

  // Try including all sections
  let assembled = sections.map((s) => s.text).join('\n');
  let tokens = estimateTokens(assembled);

  if (tokens <= maxTokens) {
    return { content: assembled, droppedEntries: 0 };
  }

  // Drop sections from lowest priority (modules first, then public surface, etc.)
  let droppedEntries = 0;
  const included = [...sections];

  // Try removing from the end (lowest priority)
  while (included.length > 0 && tokens > maxTokens) {
    const dropped = included.pop()!;
    // Count dropped entries (rough: count lines starting with '- ' or '### ')
    const entryCount = (dropped.text.match(/^- /gm) || []).length + (dropped.text.match(/^### /gm) || []).length;
    droppedEntries += entryCount;
    assembled = included.map((s) => s.text).join('\n');
    tokens = estimateTokens(assembled);
  }

  // If still over budget, hard-truncate the remaining text
  if (tokens > maxTokens) {
    const charBudget = maxTokens * 4;
    assembled = assembled.slice(0, charBudget);
    // Don't count specific dropped entries for hard truncate
  }

  const footer = `\n_(truncated to ${estimateTokens(assembled)} tokens; dropped ${droppedEntries} entries)_\n`;
  assembled += footer;

  return { content: assembled, droppedEntries };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function getCachePath(root: string): string {
  return join(root, '.anatoly', 'cache', 'internal-digest.json');
}

function readCache(root: string): CachedDigest | null {
  const cachePath = getCachePath(root);
  if (!existsSync(cachePath)) return null;
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as CachedDigest;
    if (parsed.fingerprint && parsed.content && typeof parsed.tokens === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(root: string, result: DigestResult): void {
  const cachePath = getCachePath(root);
  const dir = join(root, '.anatoly', 'cache');
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build a deterministic internal documentation digest for lite mode.
 *
 * Produces a structured markdown summary of the project's modules, public
 * API surface, reference doc paths, and inline doc-comments — all without
 * any LLM calls. The result is bounded by `max_tokens` from config and
 * cached via SHA-256 fingerprint invalidation.
 */
export async function buildInternalDocsDigest(
  projectRoot: string,
  tasks: Task[],
  referenceDocs: ReferenceDoc[],
  config: Config,
): Promise<DigestResult> {
  const maxTokens = config.documentation?.internal?.lite?.max_tokens ?? 4000;
  const fingerprint = computeFingerprint(tasks, referenceDocs, config);

  // Check cache
  const cached = readCache(projectRoot);
  if (cached && cached.fingerprint === fingerprint) {
    return cached;
  }

  // Build sections
  const modulesSection = buildModulesSection(tasks);
  const publicSurfaceSection = buildPublicSurfaceSection(tasks);
  const referenceIndexSection = buildReferenceIndexSection(referenceDocs);
  const docCommentsSection = buildInlineDocCommentsSection(referenceDocs);

  // Assemble with truncation
  const { content } = truncateToFit(
    modulesSection,
    publicSurfaceSection,
    referenceIndexSection,
    docCommentsSection,
    maxTokens,
  );

  // Prepend frontmatter marking the digest as authoritative (Story 55.5)
  const frontmatter = '---\nstatus: evaluated\nsource: reference-digest\n---\n';
  const fullContent = frontmatter + content;

  const tokens = estimateTokens(fullContent);
  const result: DigestResult = { tokens, content: fullContent, fingerprint };

  // Write cache
  writeCache(projectRoot, result);

  return result;
}
