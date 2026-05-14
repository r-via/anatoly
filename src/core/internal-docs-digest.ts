// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Internal-documentation digest for lite mode.
 *
 * Lite mode targets repos whose reference docs (`documentation.reference.paths`)
 * fit verbatim within `documentation.internal.lite.max_tokens` (default 12000).
 * The digest consolidates that content into a single Markdown blob injected as
 * authoritative ground truth into the prompts of `correction`, `best-practices`,
 * and `overengineering` (see {@link renderReferenceDocsContext}).
 *
 * Pipeline:
 *   inputs (tasks, referenceDocs, max_tokens, on_overflow)
 *     → SHA-256 fingerprint (mixes content, not only paths)
 *     → cache hit ? return cached : rebuild
 *     → assemble 3 sections in priority order:
 *         1. `## Reference content`     (full content of README/specs/md docs — top priority)
 *         2. `## Inline doc-comments`   (jsdoc/godoc/etc. extracted via tree-sitter)
 *         3. `## Public surface`        (exported symbols, structural scope — lowest priority)
 *     → if it fits in max_tokens → done
 *     → otherwise apply `on_overflow`:
 *         - `warn` (default): drop low-priority sections, then individual ref docs
 *           from lowest-source-priority (md → spec → readme) until it fits.
 *           Emit a logger warning and prepend an `> INCOMPLETE:` marker so the
 *           LLM sees the picture is partial.
 *         - `fail`: throw {@link DigestOverflowError} so CI catches the misconfig.
 *     → prepend `status: evaluated` frontmatter
 *     → write `.anatoly/cache/internal-digest.yaml` and return
 *
 * Lite intentionally does NOT include a flat `## Modules` list — that role is
 * covered by `ctx.projectTree` (directory tree built once and injected into
 * axes that need scope, today only best-practices). Adding it here would
 * duplicate info while stealing budget from authoritative content.
 *
 * Lite is for *simple/medium* repos. For repos whose reference docs cannot fit
 * in any reasonable budget, switch to `documentation.internal.mode: full`,
 * which LLM-curates per-module pages into `.anatoly/state/internal-docs/` with
 * 3-way coherence and arbitration.
 *
 * Cache layout (per project):
 *   `.anatoly/cache/internal-digest.yaml`
 *     `{ tokens, fingerprint, incomplete, content }`
 *   YAML's literal block-scalar (`content: |`) keeps the Markdown un-escaped
 *   and directly readable in an editor.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { Task } from '../schemas/task.js';
import type { ReferenceDoc } from './reference-docs-resolver.js';
import type { Config } from '../schemas/config.js';
import { getLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestResult {
  tokens: number;
  content: string;
  fingerprint: string;
  /** True when reference docs or low-priority sections were dropped to fit the budget. */
  incomplete: boolean;
}

interface CachedDigest extends DigestResult {}

/**
 * Thrown when the consolidated reference content does not fit in
 * `documentation.internal.lite.max_tokens` and `on_overflow` is set to `fail`.
 * The message is actionable and lists the docs that would have been dropped.
 */
export class DigestOverflowError extends Error {
  constructor(
    public droppedRefs: string[],
    public droppedSections: string[],
    public maxTokens: number,
  ) {
    const refList = droppedRefs.length ? `\n  dropped reference docs: ${droppedRefs.map((p) => `\`${p}\``).join(', ')}` : '';
    const secList = droppedSections.length ? `\n  dropped sections: ${droppedSections.join(', ')}` : '';
    super(
      `Lite-mode digest exceeded documentation.internal.lite.max_tokens (${maxTokens}).${refList}${secList}\n` +
        '  Either raise max_tokens, prune documentation.reference.paths, or switch to documentation.internal.mode: full.',
    );
    this.name = 'DigestOverflowError';
  }
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
 * SHA-256 fingerprint over the serialised inputs that affect the output:
 *   - sorted `file:hash` pairs from tasks (code surface)
 *   - sorted `ref:path:source:contentHash` triplets (so editing a doc invalidates the cache)
 *   - lite config signature (max_tokens, on_overflow)
 */
function computeFingerprint(tasks: Task[], referenceDocs: ReferenceDoc[], config: Config): string {
  const h = createHash('sha256');
  const sortedTasks = [...tasks].sort((a, b) => a.file.localeCompare(b.file));
  for (const t of sortedTasks) {
    h.update(`${t.file}:${t.hash}\n`);
  }
  const sortedRefs = [...referenceDocs].sort((a, b) => a.path.localeCompare(b.path));
  for (const r of sortedRefs) {
    const contentHash = createHash('sha256').update(r.content).digest('hex').slice(0, 16);
    h.update(`ref:${r.path}:${r.source}:${contentHash}\n`);
  }
  // `max_tokens` shapes the output (governs truncation). `on_overflow` is
  // intentionally NOT mixed: it only governs behaviour when overflow happens
  // and produces identical content otherwise — toggling it should not
  // invalidate a cache whose underlying content is unchanged.
  const lite = config.documentation?.internal?.lite;
  h.update(`max_tokens:${lite?.max_tokens ?? 12000}\n`);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Section model — each section has a header and a list of independently-droppable entries
// ---------------------------------------------------------------------------

interface SectionEntry {
  /** Stable identifier used in INCOMPLETE markers (file path or symbol locator). */
  id: string;
  text: string;
}

interface Section {
  name: 'reference-content' | 'inline-doc-comments' | 'public-surface';
  header: string;
  entries: SectionEntry[];
}

/** Render a section, or empty string if it has no entries. */
function renderSection(s: Section): string {
  if (s.entries.length === 0) return '';
  return `${s.header}\n${s.entries.map((e) => e.text).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Strip an optional YAML frontmatter block from the head of a reference doc.
 * Reference docs (README, spec, md) sometimes carry their own frontmatter
 * (`---\nkey: value\n---\n…`), and injecting it verbatim into the digest
 * would create nested frontmatter that confuses the parser and the LLM.
 */
function stripReferenceFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
}

/**
 * Reference content section — the verbatim body of human-authored docs
 * (README, specs, `docs/*.md`). Ordered by source priority (readme > spec > md)
 * so that overflow drops the least-load-bearing docs first.
 */
function buildReferenceContentSection(referenceDocs: ReferenceDoc[]): Section {
  const SOURCE_PRIORITY: Record<string, number> = { readme: 0, spec: 1, md: 2 };
  const docs = referenceDocs
    .filter((d) => d.source !== 'comment')
    .slice()
    .sort((a, b) => {
      const pa = SOURCE_PRIORITY[a.source] ?? 99;
      const pb = SOURCE_PRIORITY[b.source] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.path.localeCompare(b.path);
    });

  const entries = docs.map<SectionEntry>((d) => {
    const body = stripReferenceFrontmatter(d.content).trimEnd();
    return {
      id: d.path,
      text: `### \`${d.path}\` (source: ${d.source})\n\n${body}\n`,
    };
  });
  return { name: 'reference-content', header: '## Reference content', entries };
}

/**
 * Inline doc-comments — JSDoc / Godoc / docstrings attached to exported symbols
 * via tree-sitter (`LanguageAdapter.extractDocComments`). Empty when the
 * project hasn't opted in or no adapter implements extraction for the language.
 */
function buildInlineDocCommentsSection(referenceDocs: ReferenceDoc[]): Section {
  const comments = referenceDocs.filter((d) => d.source === 'comment');
  const entries = comments.map<SectionEntry>((c) => ({
    id: c.symbol ? `${c.path}:${c.symbol}` : c.path,
    text: `### \`${c.symbol ?? c.path}\`\n\n${c.content.trimEnd()}\n`,
  }));
  return { name: 'inline-doc-comments', header: '## Inline doc-comments', entries };
}

/**
 * Public surface — exported symbols grouped by file. Low-priority structural
 * scope info: useful for `overengineering` to judge whether an abstraction is
 * justified, but not authoritative. Dropped before any reference content when
 * the budget is tight.
 */
function buildPublicSurfaceSection(tasks: Task[]): Section {
  const sorted = [...tasks].sort((a, b) => a.file.localeCompare(b.file));
  const entries: SectionEntry[] = [];
  for (const t of sorted) {
    const exported = t.symbols.filter((s) => s.exported);
    if (exported.length === 0) continue;
    const lines = exported.map((s) => `- ${s.kind} \`${s.name}\` (L${s.line_start}–L${s.line_end})`);
    entries.push({ id: t.file, text: `### \`${t.file}\`\n\n${lines.join('\n')}\n` });
  }
  return { name: 'public-surface', header: '## Public surface', entries };
}

// ---------------------------------------------------------------------------
// Assembly with budget-aware overflow handling
// ---------------------------------------------------------------------------

interface AssemblyOutcome {
  content: string;
  incomplete: boolean;
  droppedRefs: string[];
  droppedSections: string[];
}

/**
 * Assemble the sections into a single Markdown blob, dropping content from the
 * lowest-priority slot first when the budget is exceeded.
 *
 * Drop strategy (uniform per-entry):
 *   - Start from the lowest-priority section (`public-surface` first, then
 *     `inline-doc-comments`, then `reference-content`).
 *   - Pop one entry at a time from the end. For `reference-content`, ordering
 *     by source priority (md → spec → readme) means the least-load-bearing
 *     doc disappears first. For `public-surface`, the alphabetically-last
 *     file goes first, which is arbitrary but uniform.
 *   - When a section becomes empty, mark it as a dropped section and remove
 *     it from the working set.
 *
 * Returns the assembled content plus the lists of dropped entries/sections,
 * which the caller surfaces as a warning or wraps into {@link DigestOverflowError}.
 */
function assembleWithBudget(sections: Section[], budgetTokens: number): AssemblyOutcome {
  const working = sections
    .filter((s) => s.entries.length > 0)
    .map((s) => ({ name: s.name, header: s.header, entries: [...s.entries] }));

  const droppedRefs: string[] = [];
  const droppedSections: string[] = [];

  const assemble = () =>
    working
      .filter((s) => s.entries.length > 0)
      .map((s) => renderSection(s))
      .join('\n');

  // Track which sections lost any entries so the marker can report them
  // (distinct from `droppedRefs` which enumerates individual ref paths).
  const touchedSections = new Set<Section['name']>();

  while (estimateTokens(assemble()) > budgetTokens && working.length > 0) {
    const last = working[working.length - 1];
    // Uniform per-entry drop: pop the last entry from the lowest-priority
    // section. This keeps the granularity consistent so a single oversized
    // file in `public-surface` doesn't wipe the whole section.
    const dropped = last.entries.pop();
    if (dropped) {
      touchedSections.add(last.name);
      if (last.name === 'reference-content') {
        droppedRefs.push(dropped.id);
      }
    }
    if (last.entries.length === 0) {
      droppedSections.push(last.name);
      working.pop();
    }
  }

  // A section is reported in `droppedSections` if any of its entries were
  // dropped — whether the section ended up empty or just partial. This makes
  // `incomplete` reflect the truth even for partial drops.
  for (const name of touchedSections) {
    if (!droppedSections.includes(name)) droppedSections.push(name);
  }

  const incomplete = touchedSections.size > 0;
  return { content: assemble(), incomplete, droppedRefs, droppedSections };
}

/** Number of dropped reference paths to enumerate in the marker before summarising the tail. */
const MARKER_MAX_LISTED_REFS = 10;

/**
 * Render the `> INCOMPLETE:` marker prepended to the digest when content was
 * dropped. The marker is visible to the LLM so it can factor in that the
 * reference picture is partial, and it lists what was dropped so a human
 * reading the YAML can act on it.
 *
 * The listed-refs portion is capped at {@link MARKER_MAX_LISTED_REFS} entries
 * (with an "… and N more" tail) so the marker itself stays small and bounded,
 * preserving the `result.tokens <= max_tokens` contract even when many docs
 * had to be dropped.
 */
function renderIncompleteMarker(outcome: AssemblyOutcome, maxTokens: number): string {
  const lines = ['> INCOMPLETE: lite-mode digest exceeded the token budget.'];
  if (outcome.droppedRefs.length > 0) {
    const shown = outcome.droppedRefs.slice(0, MARKER_MAX_LISTED_REFS);
    const list = shown.map((p) => `\`${p}\``).join(', ');
    const tail =
      outcome.droppedRefs.length > MARKER_MAX_LISTED_REFS
        ? ` (… and ${outcome.droppedRefs.length - MARKER_MAX_LISTED_REFS} more)`
        : '';
    lines.push(`> Dropped reference docs (${outcome.droppedRefs.length}): ${list}${tail}`);
  }
  if (outcome.droppedSections.length > 0) {
    lines.push(`> Dropped sections: ${outcome.droppedSections.join(', ')}`);
  }
  lines.push(
    `> Raise documentation.internal.lite.max_tokens (current: ${maxTokens}), prune documentation.reference.paths, or switch to documentation.internal.mode: full.`,
  );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cache (single YAML file — block-scalar keeps the Markdown directly readable)
// ---------------------------------------------------------------------------

function getCachePath(root: string): string {
  return join(root, '.anatoly', 'cache', 'internal-digest.yaml');
}

function readCache(root: string): CachedDigest | null {
  const cachePath = getCachePath(root);
  if (!existsSync(cachePath)) return null;
  try {
    const parsed = yamlParse(readFileSync(cachePath, 'utf-8')) as Partial<CachedDigest>;
    if (
      typeof parsed?.tokens === 'number' &&
      typeof parsed.fingerprint === 'string' &&
      typeof parsed.content === 'string' &&
      typeof parsed.incomplete === 'boolean'
    ) {
      return parsed as CachedDigest;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(root: string, result: DigestResult): void {
  const dir = join(root, '.anatoly', 'cache');
  mkdirSync(dir, { recursive: true });
  // `blockQuote: 'literal'` forces a `|`-scalar for `content`, preserving newlines
  // and Markdown formatting in a directly-readable form.
  const serialized = yamlStringify(
    {
      tokens: result.tokens,
      fingerprint: result.fingerprint,
      incomplete: result.incomplete,
      content: result.content,
    },
    { blockQuote: 'literal', lineWidth: 0 },
  );
  writeFileSync(getCachePath(root), serialized, 'utf-8');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build the lite-mode digest. See the file-level doc for the contract.
 *
 * Throws {@link DigestOverflowError} when the content exceeds `max_tokens`
 * and `on_overflow` is `fail`. With the default (`warn`), the function emits
 * a logger warning, prepends an `> INCOMPLETE:` marker to the content, and
 * still returns a usable (partial) digest.
 */
export async function buildInternalDocsDigest(
  projectRoot: string,
  tasks: Task[],
  referenceDocs: ReferenceDoc[],
  config: Config,
): Promise<DigestResult | null> {
  const liteConfig = config.documentation?.internal?.lite;
  const maxTokens = liteConfig?.max_tokens ?? 12000;
  const onOverflow = liteConfig?.on_overflow ?? 'warn';
  const fingerprint = computeFingerprint(tasks, referenceDocs, config);

  const cached = readCache(projectRoot);
  if (cached && cached.fingerprint === fingerprint) {
    return cached;
  }

  const sections = [
    buildReferenceContentSection(referenceDocs),
    buildInlineDocCommentsSection(referenceDocs),
    buildPublicSurfaceSection(tasks),
  ];

  // Nothing authoritative to ship — skip the digest entirely so the caller
  // sets `ctx.internalDigest = null` and `renderReferenceDocsContext` doesn't
  // inject an empty "AUTHORITATIVE" section into axis prompts.
  if (sections.every((s) => s.entries.length === 0)) {
    return null;
  }

  // Frontmatter and the optional INCOMPLETE marker are prepended below.
  // Reserve their worst-case token cost so the final result stays within
  // max_tokens even with the maximum number of listed dropped refs.
  const frontmatter = '---\nstatus: evaluated\nsource: reference-digest\n---\n';
  const MARKER_RESERVE_TOKENS = 256;
  const innerBudget = Math.max(0, maxTokens - estimateTokens(frontmatter) - MARKER_RESERVE_TOKENS);

  const outcome = assembleWithBudget(sections, innerBudget);

  if (outcome.incomplete && onOverflow === 'fail') {
    throw new DigestOverflowError(outcome.droppedRefs, outcome.droppedSections, maxTokens);
  }

  if (outcome.incomplete) {
    const log = getLogger();
    const refList = outcome.droppedRefs.length ? ` refs=[${outcome.droppedRefs.join(', ')}]` : '';
    const secList = outcome.droppedSections.length ? ` sections=[${outcome.droppedSections.join(', ')}]` : '';
    log.warn(
      `internal-docs lite digest overflow: max_tokens=${maxTokens} exceeded;${refList}${secList}. ` +
        'Raise documentation.internal.lite.max_tokens, prune documentation.reference.paths, or switch to documentation.internal.mode: full.',
    );
  }

  const marker = outcome.incomplete ? renderIncompleteMarker(outcome, maxTokens) : '';
  const fullContent = `${frontmatter}${marker}${outcome.content}`;
  const tokens = estimateTokens(fullContent);

  const result: DigestResult = {
    tokens,
    content: fullContent,
    fingerprint,
    incomplete: outcome.incomplete,
  };
  writeCache(projectRoot, result);
  return result;
}
