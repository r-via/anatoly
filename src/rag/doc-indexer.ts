// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { globSync } from 'tinyglobby';
import { z } from 'zod';
import { embedNlpBatch } from './embeddings.js';
import { extractJson } from '../utils/extract-json.js';
import { contextLogger, runWithContext } from '../utils/log-context.js';
import { runSingleTurnQuery } from '../core/axis-evaluator.js';
import type { TransportRouter } from '../core/transports/index.js';
import { resolveSystemPrompt } from '../core/prompt-resolver.js';
import type { VectorStore } from './vector-store.js';

// ---------------------------------------------------------------------------
// Doc section cache (stored in cache_{lite|advanced}.json → docEntries key)
// ---------------------------------------------------------------------------

interface DocCacheEntry {
  /** SHA-256 of the full doc file content. */
  sha: string;
  /** Section IDs indexed from this file. */
  sectionIds: string[];
}

export interface DocCacheData {
  [filePath: string]: DocCacheEntry;
}

function ragCachePath(projectRoot: string, suffix: string): string {
  return resolve(projectRoot, '.anatoly', 'rag', `cache_${suffix}.json`);
}

// ---------------------------------------------------------------------------
// Doc chunk cache (stores Haiku chunking results by file SHA)
// ---------------------------------------------------------------------------

interface DocChunkCacheEntry {
  sha: string;
  sections: Array<{ heading: string; embedText: string; content: string }>;
}

interface DocChunkCache {
  [filePath: string]: DocChunkCacheEntry;
}

function docChunkCachePath(projectRoot: string, suffix: string): string {
  return resolve(projectRoot, '.anatoly', 'rag', `doc_chunk_cache_${suffix}.json`);
}

function loadDocChunkCache(projectRoot: string, suffix: string): DocChunkCache {
  const path = docChunkCachePath(projectRoot, suffix);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DocChunkCache;
  } catch {
    return {};
  }
}

function saveDocChunkCache(projectRoot: string, suffix: string, cache: DocChunkCache): void {
  const path = docChunkCachePath(projectRoot, suffix);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2));
}

function computeDocSha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Load doc-section cache entries from the shared RAG cache JSON file.
 *
 * Reads `cache_{suffix}.json` and extracts the `docEntries` key, which is a
 * sub-section of the multi-purpose RAG cache file. Returns an empty object if
 * the file is missing or unparseable.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param suffix - Cache variant discriminator (e.g. `'lite'` or `'advanced'`).
 * @returns Mapping of relative file paths to their cached doc entry (SHA + section IDs).
 */
export function loadDocCacheFromRagCache(projectRoot: string, suffix: string): DocCacheData {
  const path = ragCachePath(projectRoot, suffix);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return data.docEntries ?? {};
  } catch {
    return {};
  }
}

/**
 * Persist doc-section cache entries back into the shared RAG cache JSON file.
 *
 * Performs a merge-preserve write: reads existing top-level keys from
 * `cache_{suffix}.json`, overwrites only the `docEntries` key, and writes
 * the result back. This avoids clobbering other cache sections (e.g. code
 * indexing entries) stored in the same file.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param suffix - Cache variant discriminator (e.g. `'lite'` or `'advanced'`).
 * @param docEntries - The doc cache data to persist.
 */
export function saveDocCacheToRagCache(projectRoot: string, suffix: string, docEntries: DocCacheData): void {
  const path = ragCachePath(projectRoot, suffix);
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { data = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* ignore */ }
  }
  data.docEntries = docEntries;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Smart-chunk changed doc files and pre-populate the chunk cache.
 *
 * Call this after the doc-update pipeline has modified `.anatoly/docs/` files.
 * For each file whose SHA differs from the cached value, runs the programmatic
 * smart chunker ({@link smartChunkDoc}) and writes the result to the chunk cache.
 * The doc SHA cache is intentionally **not** updated so that the next RAG run
 * detects the change, finds a chunk-cache hit (skipping Haiku), and only needs
 * to re-embed + upsert to the vector store.
 *
 * @returns Number of files that were re-chunked.
 */
export function smartChunkAndCache(projectRoot: string, docsDir: string, cacheSuffix: string): number {
  const absDocsDir = resolve(projectRoot, docsDir);
  if (!existsSync(absDocsDir)) return 0;

  const files = globSync(['**/*.md'], { cwd: absDocsDir, absolute: true });
  if (files.length === 0) return 0;

  const docCache = loadDocCacheFromRagCache(projectRoot, cacheSuffix);
  const chunkCache = loadDocChunkCache(projectRoot, cacheSuffix);
  let updated = 0;

  for (const absPath of files) {
    const relPath = relative(projectRoot, absPath);
    const content = readFileSync(absPath, 'utf-8');
    const sha = computeDocSha(content);

    // Skip files whose SHA already matches the doc cache (unchanged since last RAG index)
    const cached = docCache[relPath];
    if (cached && cached.sha === sha) continue;

    // Also skip if chunk cache already has this SHA (already smart-chunked)
    const existingChunk = chunkCache[relPath];
    if (existingChunk && existingChunk.sha === sha) continue;

    const sections = smartChunkDoc(relPath, content);
    chunkCache[relPath] = {
      sha,
      sections: sections.map(s => ({ heading: s.heading, embedText: s.embedText, content: s.content })),
    };
    updated++;
  }

  if (updated > 0) {
    saveDocChunkCache(projectRoot, cacheSuffix, chunkCache);
  }

  return updated;
}

/**
 * Cheaply count how many doc files have changed vs cached (SHA comparison only, no chunking).
 * Returns `null` when the docs directory does not exist.
 */
export function countChangedDocs(
  projectRoot: string,
  docsDir: string,
  cacheSuffix: string,
): { total: number; changed: number; cached: number } | null {
  const absDocsDir = resolve(projectRoot, docsDir);
  if (!existsSync(absDocsDir)) return null;

  const files = globSync(['**/*.md'], { cwd: absDocsDir, absolute: true });
  if (files.length === 0) return { total: 0, changed: 0, cached: 0 };

  const cache = loadDocCacheFromRagCache(projectRoot, cacheSuffix);
  let cached = 0;
  let changed = 0;

  for (const absPath of files) {
    const relPath = relative(projectRoot, absPath);
    const source = readFileSync(absPath, 'utf-8');
    if (isScaffoldingOnly(source)) continue;
    const sha = computeDocSha(source);
    if (cache[relPath]?.sha === sha) {
      cached++;
    } else {
      changed++;
    }
  }

  return { total: changed + cached, changed, cached };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocSection {
  /** Relative path to the doc file (from project root). */
  filePath: string;
  /** Section title (from Haiku semantic chunking). */
  heading: string;
  /** Prose-only content for NLP embedding (code/tables stripped). */
  embedText: string;
  /** Full content including code/tables (injected into LLM prompt at review time). */
  content: string;
}

// ---------------------------------------------------------------------------
// Haiku semantic chunking
// ---------------------------------------------------------------------------

const ChunkSchema = z.object({
  title: z.string(),
  content: z.string(),
});

const BatchChunkResultSchema = z.object({
  sourceSection: z.number(),
  sections: z.array(ChunkSchema),
});

const BatchChunkResponseSchema = z.object({
  results: z.array(BatchChunkResultSchema),
});

function getRefineSectionPrompt(): string {
  return resolveSystemPrompt('rag.section-refiner');
}

/** Maximum combined prose characters per batch to avoid quality degradation. */
export const MAX_BATCH_CHARS = 30_000;

/**
 * Split eligible sections into sub-batches where each batch's total prose
 * stays under {@link MAX_BATCH_CHARS}. Returns at least one batch even if the
 * first section alone exceeds the limit.
 */
export function splitIntoBatches(
  sections: Array<{ section: DocSection; prose: string; originalIndex: number }>,
): Array<Array<{ section: DocSection; prose: string; originalIndex: number }>> {
  const batches: Array<Array<{ section: DocSection; prose: string; originalIndex: number }>> = [];
  let current: Array<{ section: DocSection; prose: string; originalIndex: number }> = [];
  let currentChars = 0;

  for (const entry of sections) {
    if (current.length > 0 && currentChars + entry.prose.length > MAX_BATCH_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(entry);
    currentChars += entry.prose.length;
  }
  if (current.length > 0) batches.push(current);

  return batches;
}

/**
 * Chunk a doc file by first splitting on H2 headings mechanically, then
 * refining eligible sections with Haiku in a single batched call per file
 * (or per sub-batch for very large documents).
 */
async function chunkDocWithHaiku(
  filePath: string,
  source: string,
  model: string,
  projectRoot: string,
  abortController?: AbortController,
  conversationDir?: string,
  router?: TransportRouter,
): Promise<{ sections: DocSection[]; costUsd: number }> {
  const log = contextLogger();
  const ac = abortController ?? new AbortController();
  const docSlug = filePath.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '-');
  let totalCostUsd = 0;

  // Step 1: mechanical H2 split (free, instant)
  const h2Sections = fallbackParseH2(filePath, source);

  if (h2Sections.length === 0) {
    // No H2 structure — send the whole doc as a single batch section (capped at MAX_BATCH_CHARS)
    let prose = stripNonProse(source);
    if (prose.length < 50) return { sections: [], costUsd: 0 };
    if (prose.length > MAX_BATCH_CHARS) {
      prose = prose.slice(0, MAX_BATCH_CHARS);
      log?.warn({ file: filePath, originalLength: stripNonProse(source).length, truncatedTo: MAX_BATCH_CHARS }, 'doc chunking: unstructured doc truncated to MAX_BATCH_CHARS');
    }
    try {
      const userMessage = `### Section 1: "${filePath}" from \`${filePath}\`\n\n${prose}`;
      const result = await runWithContext({ axis: 'doc-chunk' }, () => runSingleTurnQuery(
        {
          systemPrompt: getRefineSectionPrompt(),
          userMessage,
          model,
          projectRoot,
          abortController: ac,
          conversationDir,
          conversationPrefix: conversationDir ? `rag__doc-chunk__${docSlug}` : undefined,
          router,
        },
        BatchChunkResponseSchema,
      ));
      totalCostUsd += result.costUsd;
      const sections = result.data.results.find(r => r.sourceSection === 1)?.sections ?? [];
      return {
        sections: sections
          .filter((s) => s.content.trim().length >= 50)
          .map((s) => ({ filePath, heading: s.title, embedText: s.content.trim(), content: s.content.trim() })),
        costUsd: totalCostUsd,
      };
    } catch (err) {
      if (ac.signal.aborted) throw err;
      log?.warn({ event: 'llm_call', file: filePath, axis: 'doc-chunk', success: false, err: String(err), fallback: 'mechanical-h2' }, 'doc chunking: Haiku failed on unstructured doc, falling back to mechanical parse');
      return { sections: [{ filePath, heading: filePath, embedText: prose, content: prose }], costUsd: totalCostUsd };
    }
  }

  // Step 2: identify eligible sections (>= 500 chars prose) for LLM refinement
  const eligible: Array<{ section: DocSection; prose: string; originalIndex: number }> = [];

  for (let i = 0; i < h2Sections.length; i++) {
    const prose = stripNonProse(h2Sections[i].content);
    if (prose.length >= 500) {
      eligible.push({ section: h2Sections[i], prose, originalIndex: i });
    }
  }

  // If nothing needs refinement, return all sections as-is
  if (eligible.length === 0) {
    return { sections: h2Sections, costUsd: 0 };
  }

  // Step 3: batch LLM calls (split into sub-batches if needed)
  const batches = splitIntoBatches(eligible);
  // Map from originalIndex → refined DocSection[]
  const refinedMap = new Map<number, DocSection[]>();

  try {
    for (const batch of batches) {
      if (ac.signal.aborted) break;

      const userMessage = batch.map((entry, i) =>
        `### Section ${i + 1}: "${entry.section.heading}" from \`${filePath}\`\n\n${entry.prose}`,
      ).join('\n\n---\n\n');

      const result = await runWithContext({ axis: 'doc-chunk' }, () => runSingleTurnQuery(
        {
          systemPrompt: getRefineSectionPrompt(),
          userMessage,
          model,
          projectRoot,
          abortController: ac,
          conversationDir,
          conversationPrefix: conversationDir ? `rag__doc-chunk__${docSlug}` : undefined,
          router,
        },
        BatchChunkResponseSchema,
      ));
      totalCostUsd += result.costUsd;

      // Map results back to original indices
      for (const batchResult of result.data.results) {
        const batchIndex = batchResult.sourceSection - 1; // 1-based → 0-based
        if (batchIndex < 0 || batchIndex >= batch.length) {
          log?.warn({ event: 'llm_call', file: filePath, axis: 'doc-chunk', sourceSection: batchResult.sourceSection, batchSize: batch.length }, 'doc chunking: LLM returned out-of-range sourceSection, skipping');
          continue;
        }
        const originalIndex = batch[batchIndex].originalIndex;
        const refined = batchResult.sections
          .filter((s) => s.content.trim().length >= 50)
          .map((s) => ({ filePath, heading: s.title, embedText: s.content.trim(), content: s.content.trim() }));
        if (refined.length > 0) {
          refinedMap.set(originalIndex, refined);
        }
      }
    }
  } catch (err) {
    if (ac.signal.aborted) throw err;
    log?.warn({ event: 'llm_call', file: filePath, axis: 'doc-chunk', success: false, err: String(err), fallback: 'mechanical-h2' }, 'doc chunking: Haiku batch refinement failed, keeping H2 sections');
    // Fallback: return all H2 sections as-is
    return { sections: h2Sections, costUsd: totalCostUsd };
  }

  // Step 4: merge passthrough + refined in original document order
  const allSections: DocSection[] = [];
  for (let i = 0; i < h2Sections.length; i++) {
    const refined = refinedMap.get(i);
    if (refined) {
      allSections.push(...refined);
    } else {
      allSections.push(h2Sections[i]);
    }
  }

  return { sections: allSections, costUsd: totalCostUsd };
}

// ---------------------------------------------------------------------------
// Fallback: mechanical H2 parsing (no LLM)
// ---------------------------------------------------------------------------

function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')     // fenced code blocks
    .replace(/`([^`\n]+)`/g, '$1')        // inline code: keep content, remove backticks
    .replace(/^\|.*\|$/gm, '')           // markdown tables
    .replace(/^>\s.*$/gm, '')            // blockquotes
    .replace(/<[^>]+>/g, '')             // HTML tags
    .replace(/^---+$/gm, '')             // horizontal rules
    .replace(/^\s*\n/gm, '\n')           // collapse blank lines
    .trim();
}

/**
 * Parse a Markdown document into {@link DocSection} entries by splitting on `## ` (H2) headings.
 *
 * Behaviour notes:
 * - Content before the first H2 is flushed as an "Introduction" section.
 * - H1 (`# `) lines in the preamble are silently skipped (treated as the page title, not content).
 * - Sections whose prose content (after {@link stripNonProse}) is shorter than 50 characters are discarded.
 *
 * @param filePath - Relative path to the doc file (passed through to each section).
 * @param source - Raw Markdown source text.
 * @returns Array of doc sections, one per H2 block that meets the minimum prose threshold.
 */
function fallbackParseH2(filePath: string, source: string): DocSection[] {
  const sections: DocSection[] = [];
  const lines = source.split('\n');

  let currentHeading: string | null = null;
  const contentLines: string[] = [];
  const preambleLines: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);

    if (h2Match) {
      if (currentHeading !== null) {
        const raw = contentLines.join('\n').trim();
        const prose = stripNonProse(raw);
        if (prose.length >= 50) {
          sections.push({ filePath, heading: currentHeading, embedText: prose, content: raw });
        }
        contentLines.length = 0;
      } else if (preambleLines.length > 0) {
        // Flush preamble (content before first H2)
        const raw = preambleLines.join('\n').trim();
        const prose = stripNonProse(raw);
        if (prose.length >= 50) {
          sections.push({ filePath, heading: 'Introduction', embedText: prose, content: raw });
        }
      }
      currentHeading = h2Match[1].trim();
    } else if (currentHeading !== null) {
      contentLines.push(line);
    } else {
      // Skip H1 lines from preamble (title, not content)
      if (!line.match(/^#\s+/)) {
        preambleLines.push(line);
      }
    }
  }

  if (currentHeading !== null) {
    const raw = contentLines.join('\n').trim();
    const prose = stripNonProse(raw);
    if (prose.length >= 50) {
      sections.push({ filePath, heading: currentHeading, embedText: prose, content: raw });
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Smart programmatic chunker (H2 + H3 + paragraph splitting)
// ---------------------------------------------------------------------------

/** Prose length above which a section is split on paragraph boundaries. */
const SMART_SPLIT_THRESHOLD = 600;

/**
 * Smart programmatic chunker that splits Markdown on H2 + H3 heading hierarchy
 * and applies paragraph-level splitting for large sections.
 *
 * Designed for internally-generated docs with clean heading structure. Produces
 * chunk sizes comparable to Haiku semantic chunking (~300 chars avg embedText)
 * without any LLM call.
 *
 * Strategy:
 * 1. Parse H2 and H3 headings into a flat block list.
 * 2. For each block, compute prose via {@link stripNonProse}.
 * 3. Blocks under {@link SMART_SPLIT_THRESHOLD} are kept as-is.
 * 4. Larger blocks are split on double-newline paragraph boundaries.
 * 5. Blocks under 50 chars prose are discarded.
 *
 * @param filePath - Relative path to the doc file.
 * @param source - Raw Markdown source text.
 * @returns Array of doc sections suitable for NLP embedding.
 */
export function smartChunkDoc(filePath: string, source: string): DocSection[] {
  const lines = source.split('\n');

  interface Block { level: number; heading: string; lines: string[]; parentH2?: string }
  const blocks: Block[] = [];
  let current: Block | null = null;
  const preambleLines: string[] = [];
  let inFence = false;

  for (const line of lines) {
    // Track fenced code blocks to avoid parsing headings inside them
    if (line.startsWith('```')) {
      inFence = !inFence;
      if (current) current.lines.push(line);
      else preambleLines.push(line);
      continue;
    }
    if (inFence) {
      if (current) current.lines.push(line);
      else preambleLines.push(line);
      continue;
    }

    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);

    if (h2) {
      if (current) blocks.push(current);
      else if (preambleLines.length > 0) {
        blocks.push({ level: 0, heading: 'Introduction', lines: [...preambleLines] });
      }
      current = { level: 2, heading: h2[1].trim(), lines: [] };
    } else if (h3 && current) {
      // Flush accumulated content before this H3
      if (current.lines.length > 0) blocks.push(current);
      // When transitioning H3→H3, use the existing parentH2; when H2→H3, use the H2's heading
      const h2Parent: string | undefined = current.level === 3 ? current.parentH2 : current.heading;
      current = { level: 3, heading: h3[1].trim(), lines: [], parentH2: h2Parent };
    } else if (current) {
      current.lines.push(line);
    } else {
      if (!line.match(/^#\s+/)) preambleLines.push(line);
    }
  }
  if (current) blocks.push(current);

  // Convert blocks to sections, splitting large ones on paragraph boundaries
  const sections: DocSection[] = [];

  for (const block of blocks) {
    const raw = block.lines.join('\n').trim();
    const prose = stripNonProse(raw);
    if (prose.length < 50) continue;

    const heading = block.level === 3 && block.parentH2
      ? `${block.parentH2} — ${block.heading}`
      : block.heading;

    if (prose.length <= SMART_SPLIT_THRESHOLD) {
      sections.push({ filePath, heading, embedText: prose, content: raw });
      continue;
    }

    // Split on double-newline paragraph boundaries
    const paragraphs = raw.split(/\n\n+/);
    let accumContent: string[] = [];
    let accumProse = '';
    let partNum = 0;

    for (const para of paragraphs) {
      const paraProse = stripNonProse(para);
      if (paraProse.length < 20) {
        accumContent.push(para);
        continue;
      }

      const combined = accumProse ? accumProse + '\n' + paraProse : paraProse;

      if (combined.length > SMART_SPLIT_THRESHOLD && accumProse.length >= 50) {
        sections.push({
          filePath,
          heading: partNum > 0 ? `${heading} (cont.)` : heading,
          embedText: accumProse,
          content: accumContent.join('\n\n'),
        });
        partNum++;
        accumContent = [para];
        accumProse = paraProse;
      } else {
        accumContent.push(para);
        accumProse = combined;
      }
    }

    if (accumProse.length >= 50) {
      sections.push({
        filePath,
        heading: partNum > 0 ? `${heading} (cont.)` : heading,
        embedText: accumProse,
        content: accumContent.join('\n\n'),
      });
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Public helpers (kept for backward compat / tests)
// ---------------------------------------------------------------------------

/**
 * Strip non-prose elements from Markdown text for embedding.
 *
 * Despite its name, this removes more than just code blocks — it delegates to
 * {@link stripNonProse} which also strips inline code backticks, Markdown
 * tables, blockquotes, HTML tags, and horizontal rules.
 *
 * Kept as an exported alias for backward compatibility.
 *
 * @param text - Raw Markdown text to clean.
 * @returns Prose-only text suitable for NLP embedding.
 */
export function stripCodeBlocks(text: string): string {
  return stripNonProse(text);
}

/**
 * Produce a deterministic 16-hex-char ID for a doc section.
 *
 * The ID is the first 16 characters of the SHA-256 hex digest of the string
 * `"doc:{filePath}:{heading}"`.
 *
 * @param filePath - Relative path to the doc file.
 * @param heading - Section heading text.
 * @returns A 16-character hexadecimal section ID.
 */
export function buildDocSectionId(filePath: string, heading: string): string {
  const input = `doc:${filePath}:${heading}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Alias for {@link fallbackParseH2}, kept as an export for backward compatibility
 * with existing callers and tests.
 */
export const parseDocSections = fallbackParseH2;

/**
 * Collect all doc sections from Markdown files in the given docs directory.
 *
 * Globs `**\/*.md` under `{projectRoot}/{docsDir}` (default `'docs'`) and
 * parses each file using the mechanical H2 parser ({@link fallbackParseH2}),
 * **not** the Haiku semantic chunker.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param docsDir - Docs directory relative to projectRoot (default `'docs'`).
 * @returns Flat array of doc sections across all discovered Markdown files.
 */
export function collectDocSections(projectRoot: string, docsDir: string = 'docs'): DocSection[] {
  const absDocsDir = resolve(projectRoot, docsDir);
  if (!existsSync(absDocsDir)) return [];

  const files = globSync(['**/*.md'], { cwd: absDocsDir, absolute: true });
  const sections: DocSection[] = [];

  for (const absPath of files) {
    const relPath = relative(projectRoot, absPath);
    const source = readFileSync(absPath, 'utf-8');
    sections.push(...fallbackParseH2(relPath, source));
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/** Options for {@link indexDocSections}. */
export interface DocIndexOptions {
  /** Absolute path to the project root directory. */
  projectRoot: string;
  /** Vector store used to upsert/delete doc section embeddings. */
  vectorStore: VectorStore;
  /** Docs directory relative to projectRoot (default `'docs'`). */
  docsDir?: string;
  /** Cache variant discriminator (default `'lite'`). */
  cacheSuffix?: string;
  /** Called after each file is fully processed, with `(current, total)` counts. */
  onProgress?: (current: number, total: number) => void;
  /** Called when processing of a file begins. */
  onFileStart?: (file: string) => void;
  /** Called when processing of a file completes. */
  onFileDone?: (file: string) => void;
  /** Model for semantic chunking (e.g. 'haiku'). If omitted, falls back to H2 parsing. */
  chunkModel?: string;
  /** Logging callback for progress and diagnostic messages. */
  onLog: (message: string) => void;
  /** Check if the caller has requested interruption (Ctrl+C). */
  isInterrupted?: () => boolean;
  /** Full path to conversations/ dir for LLM conversation dumps. */
  conversationDir?: string;
  /** Mode-aware transport router for concurrency and transport selection. */
  router?: TransportRouter;
  /** Max parallel file processing (default 4, should match code indexing concurrency). */
  concurrency?: number;
  /** Doc source discriminator for the vector store. */
  docSource?: 'internal' | 'project';
}

/** Result of doc section indexing. */
export interface DocIndexResult {
  /** Number of sections newly indexed in this run. */
  sections: number;
  /** True when doc files exist but were all cache-hits (unchanged). */
  cached: boolean;
  /** Total LLM cost (USD) incurred for doc chunking in this run. */
  costUsd: number;
}

/**
 * Parse /docs/ into semantic sections (via Haiku or H2 fallback),
 * embed prose via NLP model, and upsert as type='doc_section' cards.
 *
 * Uses SHA-256 per doc file to skip unchanged files.
 */
export async function indexDocSections(options: DocIndexOptions): Promise<DocIndexResult> {
  const { projectRoot, vectorStore, docsDir = 'docs', cacheSuffix = 'lite', chunkModel, onLog, onProgress, onFileStart, onFileDone, isInterrupted, conversationDir, router, concurrency = 4, docSource = 'project' } = options;

  const absDocsDir = resolve(projectRoot, docsDir);
  const sourceLabel = docSource === 'internal' ? 'internal' : 'project';
  if (!existsSync(absDocsDir)) {
    onLog(`rag: no ${sourceLabel} docs/ directory found`);
    return { sections: 0, cached: false, costUsd: 0 };
  }

  const files = globSync(['**/*.md'], { cwd: absDocsDir, absolute: true });
  if (files.length === 0) {
    onLog(`rag: no ${sourceLabel} doc files found`);
    return { sections: 0, cached: false, costUsd: 0 };
  }

  const cache = loadDocCacheFromRagCache(projectRoot, cacheSuffix);
  const newCache: DocCacheData = {};
  const chunkCache = loadDocChunkCache(projectRoot, cacheSuffix);
  const newChunkCache: DocChunkCache = {};

  const changedFiles: Array<{ relPath: string; source: string; sha: string }> = [];
  let cachedCount = 0;
  let scaffoldSkipped = 0;

  for (const absPath of files) {
    const relPath = relative(projectRoot, absPath);
    const source = readFileSync(absPath, 'utf-8');

    // Skip scaffolded-only pages — no real content to index
    if (isScaffoldingOnly(source)) {
      scaffoldSkipped++;
      continue;
    }

    const sha = computeDocSha(source);
    const cached = cache[relPath];

    if (cached && cached.sha === sha) {
      newCache[relPath] = cached;
      cachedCount++;
    } else {
      changedFiles.push({ relPath, source, sha });
    }
  }

  if (scaffoldSkipped > 0) {
    onLog(`rag: skipped ${scaffoldSkipped} scaffolded-only ${sourceLabel} doc files`);
  }

  // Remove stale sections for deleted/changed files
  const staleFiles = Object.keys(cache).filter((f) => !newCache[f]);
  for (const staleFile of staleFiles) {
    const staleIds = cache[staleFile]?.sectionIds ?? [];
    if (staleIds.length > 0) {
      await vectorStore.deleteDocSections(staleIds);
    }
  }

  if (changedFiles.length === 0) {
    onLog(`rag: ${sourceLabel} doc sections up to date (${cachedCount} files cached)`);
    saveDocCacheToRagCache(projectRoot, cacheSuffix, newCache);
    return { sections: 0, cached: true, costUsd: 0 };
  }

  onLog(`rag: processing ${changedFiles.length} ${sourceLabel} doc files via smart-chunk (${cachedCount} cached)`);

  let totalIndexed = 0;
  let totalCostUsd = 0;
  let docFileCounter = 0;

  // Phase 1: Chunk all files (smart programmatic chunker or chunk cache)
  interface ChunkedFile {
    relPath: string;
    sha: string;
    sections: DocSection[];
  }
  const chunkedFiles: ChunkedFile[] = [];

  const chunkFile = async ({ relPath, source, sha }: { relPath: string; source: string; sha: string }) => {
    if (isInterrupted?.()) return;
    onFileStart?.(relPath);
    docFileCounter++;
    onLog(`rag: [${docFileCounter}/${changedFiles.length}] chunking ${relPath}`);

    // Check chunk cache first, then smart-chunk programmatically (no LLM)
    const cachedChunks = chunkCache[relPath];
    let sections: DocSection[];
    if (cachedChunks && cachedChunks.sha === sha) {
      sections = cachedChunks.sections.map(s => ({ filePath: relPath, ...s }));
      onLog(`rag: ${relPath} → ${sections.length} sections (from chunk cache)`);
    } else {
      sections = smartChunkDoc(relPath, source);
      onLog(`rag: ${relPath} → ${sections.length} sections (smart-chunked)`);
    }

    chunkedFiles.push({ relPath, sha, sections });
  };

  for (let i = 0; i < changedFiles.length; i += concurrency) {
    const batch = changedFiles.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(chunkFile));
  }

  // Phase 2: Collect all sections across files, embed in one mega-batch
  interface FileCards {
    relPath: string;
    sha: string;
    sections: DocSection[];
    cards: Array<{ id: string; filePath: string; name: string; summary: string }>;
    sectionIds: string[];
    startIdx: number;
    count: number;
  }
  const allTextsToEmbed: string[] = [];
  const fileCardsList: FileCards[] = [];

  for (const { relPath, sha, sections } of chunkedFiles) {
    if (sections.length === 0) {
      newCache[relPath] = { sha, sectionIds: [] };
      newChunkCache[relPath] = { sha, sections: [] };
      continue;
    }

    const cards: Array<{ id: string; filePath: string; name: string; summary: string }> = [];
    const sectionIds: string[] = [];
    const startIdx = allTextsToEmbed.length;

    for (const section of sections) {
      const id = buildDocSectionId(section.filePath, section.heading);
      onLog(`rag:   section "${section.heading}" (${section.embedText.length} chars)`);
      cards.push({ id, filePath: section.filePath, name: section.heading, summary: section.embedText.slice(0, 400) });
      sectionIds.push(id);
      allTextsToEmbed.push(section.embedText);
    }

    fileCardsList.push({ relPath, sha, sections, cards, sectionIds, startIdx, count: sections.length });
  }

  if (allTextsToEmbed.length > 0) {
    onLog(`rag: embedding ${allTextsToEmbed.length} sections across ${fileCardsList.length} files in one batch...`);
    const allEmbeddings = await embedNlpBatch(allTextsToEmbed);

    // Phase 3: Upsert per file using sliced embeddings
    for (const fc of fileCardsList) {
      const fileEmbeddings = allEmbeddings.slice(fc.startIdx, fc.startIdx + fc.count);
      await vectorStore.upsertDocSections(fc.cards, fileEmbeddings, docSource);
      newCache[fc.relPath] = { sha: fc.sha, sectionIds: fc.sectionIds };
      newChunkCache[fc.relPath] = { sha: fc.sha, sections: fc.sections.map(s => ({ heading: s.heading, embedText: s.embedText, content: s.content })) };
      totalIndexed += fc.sections.length;
      onLog(`rag: ${fc.relPath} → ${fc.sections.length} sections`);
      onFileDone?.(fc.relPath);
    }
  }

  // Emit progress for files with no sections
  for (const { relPath } of chunkedFiles) {
    if (!fileCardsList.some(fc => fc.relPath === relPath)) {
      onFileDone?.(relPath);
    }
  }
  onProgress?.(changedFiles.length, changedFiles.length);

  saveDocCacheToRagCache(projectRoot, cacheSuffix, newCache);
  // Merge chunk cache: keep entries for unchanged files, add new entries
  const mergedChunkCache: DocChunkCache = {};
  for (const [path, entry] of Object.entries(chunkCache)) {
    if (newCache[path]) mergedChunkCache[path] = entry; // file still exists and cached
  }
  Object.assign(mergedChunkCache, newChunkCache); // add/overwrite with new entries
  saveDocChunkCache(projectRoot, cacheSuffix, mergedChunkCache);
  onLog(`rag: indexed ${totalIndexed} ${sourceLabel} doc sections from ${changedFiles.length} files`);

  return { sections: totalIndexed, cached: false, costUsd: totalCostUsd };
}

/**
 * Detect scaffolded-only pages: contain SCAFFOLDING comments but
 * very little real prose content (< 200 chars after stripping comments and headings).
 */
function isScaffoldingOnly(source: string): boolean {
  if (!source.includes('<!-- SCAFFOLDING')) return false;
  const stripped = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#+\s.*/gm, '')
    .replace(/^\s*$/gm, '')
    .trim();
  return stripped.length < 200;
}

// ---------------------------------------------------------------------------
// Doc tree identity detection
// ---------------------------------------------------------------------------

/**
 * Check whether two documentation directories have byte-identical `.md` files.
 *
 * Returns `true` when:
 * - Both directories don't exist (no docs at all)
 * - Both exist and contain the exact same set of `.md` files with identical content
 *
 * Returns `false` when:
 * - Only one directory exists
 * - The sets of `.md` relative paths differ
 * - Any file differs in size or SHA-256 content hash
 *
 * Used by the orchestrator to skip double-chunking when `docs/` is a copy of `.anatoly/docs/`.
 */
export function areDocTreesIdentical(
  projectRoot: string,
  projectDocsDir: string,
  internalDocsDir: string,
): boolean {
  const absProject = resolve(projectRoot, projectDocsDir);
  const absInternal = resolve(projectRoot, internalDocsDir);

  const projectExists = existsSync(absProject);
  const internalExists = existsSync(absInternal);

  // Both missing → identical (no docs at all)
  if (!projectExists && !internalExists) return true;

  // Only one exists → not identical
  if (!projectExists || !internalExists) return false;

  const projectFiles = globSync(['**/*.md'], { cwd: absProject }).sort();
  const internalFiles = globSync(['**/*.md'], { cwd: absInternal }).sort();

  // Different file sets → not identical
  if (projectFiles.length !== internalFiles.length) return false;
  for (let i = 0; i < projectFiles.length; i++) {
    if (projectFiles[i] !== internalFiles[i]) return false;
  }

  // Both empty → identical
  if (projectFiles.length === 0) return true;

  // Compare file-by-file: size first (cheap), then SHA-256
  for (const relPath of projectFiles) {
    const projectPath = resolve(absProject, relPath);
    const internalPath = resolve(absInternal, relPath);

    // Size short-circuit
    const projectSize = statSync(projectPath).size;
    const internalSize = statSync(internalPath).size;
    if (projectSize !== internalSize) return false;

    // SHA-256 content comparison
    const projectSha = computeDocSha(readFileSync(projectPath, 'utf-8'));
    const internalSha = computeDocSha(readFileSync(internalPath, 'utf-8'));
    if (projectSha !== internalSha) return false;
  }

  return true;
}

/**
 * Remap a doc file path from one directory prefix to another.
 *
 * Example: `remapDocPath('.anatoly/docs/02-Arch/foo.md', '.anatoly/docs', 'docs')` → `'docs/02-Arch/foo.md'`
 */
export function remapDocPath(filePath: string, fromPrefix: string, toPrefix: string): string {
  // Normalize: strip trailing slashes for consistent comparison
  const from = fromPrefix.replace(/\/+$/, '');
  const to = toPrefix.replace(/\/+$/, '');

  if (filePath.startsWith(from + '/')) {
    return to + filePath.slice(from.length);
  }
  if (filePath === from) {
    return to;
  }
  return filePath;
}
