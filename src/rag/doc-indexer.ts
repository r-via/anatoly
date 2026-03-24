// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { globSync } from 'tinyglobby';
import { z } from 'zod';
import { embedNlpBatch } from './embeddings.js';
import { extractJson } from '../utils/extract-json.js';
import { contextLogger, runWithContext } from '../utils/log-context.js';
import { runSingleTurnQuery } from '../core/axis-evaluator.js';
import type { Semaphore } from '../core/sdk-semaphore.js';
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

function computeDocSha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

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

const ChunkResponseSchema = z.object({
  sections: z.array(ChunkSchema),
});

function getRefineSectionPrompt(): string {
  return resolveSystemPrompt('rag.section-refiner');
}

/**
 * Chunk a doc file by first splitting on H2 headings mechanically, then
 * refining each section with Haiku. This keeps LLM context small (one
 * section at a time) and avoids hallucinations on large documents.
 */
async function chunkDocWithHaiku(
  filePath: string,
  source: string,
  model: string,
  projectRoot: string,
  abortController?: AbortController,
  conversationDir?: string,
  semaphore?: Semaphore,
): Promise<DocSection[]> {
  const log = contextLogger();
  const ac = abortController ?? new AbortController();

  // Step 1: mechanical H2 split (free, instant)
  const h2Sections = fallbackParseH2(filePath, source);

  if (h2Sections.length === 0) {
    // No H2 structure — send the whole doc (prose only) to Haiku
    const prose = stripNonProse(source);
    if (prose.length < 50) return [];
    try {
      const docSlug = filePath.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '-');
      const result = await runWithContext({ axis: 'doc-chunk' }, () => runSingleTurnQuery(
        {
          systemPrompt: getRefineSectionPrompt(),
          userMessage: `Section from \`${filePath}\`:\n\n${prose}`,
          model,
          projectRoot,
          abortController: ac,
          conversationDir,
          conversationPrefix: conversationDir ? `rag__doc-chunk__${docSlug}` : undefined,
          semaphore,
        },
        ChunkResponseSchema,
      ));
      return result.data.sections
        .filter((s) => s.content.trim().length >= 50)
        .map((s) => ({ filePath, heading: s.title, embedText: s.content.trim(), content: s.content.trim() }));
    } catch (err) {
      if (ac.signal.aborted) throw err;
      log?.warn({ event: 'llm_call', file: filePath, axis: 'doc-chunk', success: false, err: String(err), fallback: 'mechanical-h2' }, 'doc chunking: Haiku failed on unstructured doc, falling back to mechanical parse');
      return [{ filePath, heading: filePath, embedText: prose, content: prose }];
    }
  }

  // Step 2: refine each H2 section with Haiku (small context per call)
  const allSections: DocSection[] = [];

  for (const section of h2Sections) {
    if (ac.signal.aborted) break;

    // Strip non-prose before checking size and sending to Haiku
    const prose = stripNonProse(section.content);

    // Small sections don't need Haiku refinement
    if (prose.length < 500) {
      allSections.push(section);
      continue;
    }

    try {
      const sectionSlug = section.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      const docSlugForSection = filePath.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '-');
      const result = await runWithContext({ axis: 'doc-chunk' }, () => runSingleTurnQuery(
        {
          systemPrompt: getRefineSectionPrompt(),
          userMessage: `Section "${section.heading}" from \`${filePath}\`:\n\n${prose}`,
          model,
          projectRoot,
          abortController: ac,
          conversationDir,
          conversationPrefix: conversationDir ? `rag__doc-chunk__${docSlugForSection}__${sectionSlug}` : undefined,
          semaphore,
        },
        ChunkResponseSchema,
      ));

      const refined = result.data.sections
        .filter((s) => s.content.trim().length >= 50)
        .map((s) => ({ filePath, heading: s.title, embedText: s.content.trim(), content: s.content.trim() }));

      allSections.push(...(refined.length > 0 ? refined : [section]));
    } catch (err) {
      if (ac.signal.aborted) throw err;
      log?.warn({ event: 'llm_call', file: filePath, section: section.heading, axis: 'doc-chunk', success: false, err: String(err), fallback: 'mechanical-h2' }, 'doc chunking: Haiku refinement failed, keeping H2 section');
      allSections.push(section);
    }
  }

  return allSections;
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
// Public helpers (kept for backward compat / tests)
// ---------------------------------------------------------------------------

export function stripCodeBlocks(text: string): string {
  return stripNonProse(text);
}

export function buildDocSectionId(filePath: string, heading: string): string {
  const input = `doc:${filePath}:${heading}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export const parseDocSections = fallbackParseH2;

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

export interface DocIndexOptions {
  projectRoot: string;
  vectorStore: VectorStore;
  docsDir?: string;
  cacheSuffix?: string;
  onProgress?: (current: number, total: number) => void;
  onFileStart?: (file: string) => void;
  onFileDone?: (file: string) => void;
  /** Model for semantic chunking (e.g. 'haiku'). If omitted, falls back to H2 parsing. */
  chunkModel?: string;
  onLog: (message: string) => void;
  /** Check if the caller has requested interruption (Ctrl+C). */
  isInterrupted?: () => boolean;
  /** Full path to conversations/ dir for LLM conversation dumps. */
  conversationDir?: string;
  /** Global SDK concurrency semaphore. */
  semaphore?: Semaphore;
  /** Max parallel file processing (default 4, should match code indexing concurrency). */
  concurrency?: number;
}

/**
 * Parse /docs/ into semantic sections (via Haiku or H2 fallback),
 * embed prose via NLP model, and upsert as type='doc_section' cards.
 *
 * Uses SHA-256 per doc file to skip unchanged files.
 */
export async function indexDocSections(options: DocIndexOptions): Promise<number> {
  const { projectRoot, vectorStore, docsDir = 'docs', cacheSuffix = 'lite', chunkModel, onLog, onProgress, onFileStart, onFileDone, isInterrupted, conversationDir, semaphore, concurrency = 4 } = options;

  const absDocsDir = resolve(projectRoot, docsDir);
  if (!existsSync(absDocsDir)) {
    onLog('rag: no docs/ directory found');
    return 0;
  }

  const files = globSync(['**/*.md'], { cwd: absDocsDir, absolute: true });
  if (files.length === 0) {
    onLog('rag: no doc files found');
    return 0;
  }

  const cache = loadDocCacheFromRagCache(projectRoot, cacheSuffix);
  const newCache: DocCacheData = {};

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
    onLog(`rag: skipped ${scaffoldSkipped} scaffolded-only doc files`);
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
    onLog(`rag: doc sections up to date (${cachedCount} files cached)`);
    saveDocCacheToRagCache(projectRoot, cacheSuffix, newCache);
    return 0;
  }

  const method = chunkModel ? `Haiku (${chunkModel})` : 'H2 fallback';
  onLog(`rag: chunking ${changedFiles.length} doc files via ${method} (${cachedCount} cached)`);

  let totalIndexed = 0;
  let docFileCounter = 0;

  // Create a shared AbortController for all Haiku calls — aborted when isInterrupted() returns true
  const ac = new AbortController();

  // Process files concurrently (semaphore bounds LLM calls inside chunkDocWithHaiku)
  const processFile = async ({ relPath, source, sha }: { relPath: string; source: string; sha: string }) => {
    if (isInterrupted?.()) {
      ac.abort();
      return;
    }
    docFileCounter++;
    onProgress?.(docFileCounter, changedFiles.length);
    onFileStart?.(relPath);
    onLog(`rag: [${docFileCounter}/${changedFiles.length}] chunking ${relPath}`);

    const sections = chunkModel
      ? await chunkDocWithHaiku(relPath, source, chunkModel, projectRoot, ac, conversationDir, semaphore)
      : fallbackParseH2(relPath, source);

    if (sections.length === 0) {
      newCache[relPath] = { sha, sectionIds: [] };
      return;
    }

    const cards: Array<{ id: string; filePath: string; name: string; summary: string }> = [];
    const sectionIds: string[] = [];
    const textsToEmbed: string[] = [];

    for (const section of sections) {
      const id = buildDocSectionId(section.filePath, section.heading);
      const chars = section.embedText.length;
      onLog(`rag:   section "${section.heading}" (${chars} chars)`);
      cards.push({ id, filePath: section.filePath, name: section.heading, summary: section.embedText.slice(0, 400) });
      sectionIds.push(id);
      textsToEmbed.push(section.embedText);
    }

    onLog(`rag: embedding ${textsToEmbed.length} sections for ${relPath}...`);
    const nlpEmbeddings = await embedNlpBatch(textsToEmbed);

    await vectorStore.upsertDocSections(cards, nlpEmbeddings);
    newCache[relPath] = { sha, sectionIds };
    totalIndexed += sections.length;
    onLog(`rag: ${relPath} → ${sections.length} sections`);
    onFileDone?.(relPath);
  };

  // Process files with bounded concurrency to avoid overwhelming the UI
  for (let i = 0; i < changedFiles.length; i += concurrency) {
    const batch = changedFiles.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(processFile));
  }

  saveDocCacheToRagCache(projectRoot, cacheSuffix, newCache);
  onLog(`rag: indexed ${totalIndexed} doc sections from ${changedFiles.length} files`);

  return totalIndexed;
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
