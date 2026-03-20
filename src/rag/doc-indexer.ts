// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { globSync } from 'tinyglobby';
import { z } from 'zod';
import { embedNlp } from './embeddings.js';
import { extractJson } from '../utils/extract-json.js';
import { contextLogger } from '../utils/log-context.js';
import { runSingleTurnQuery } from '../core/axis-evaluator.js';
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

const CHUNK_SYSTEM_PROMPT = `You are a documentation analyzer. Given a markdown document, split it into semantic sections. Each section should cover ONE distinct concept or topic.

Rules:
- Each section needs a short descriptive title (not the original heading — describe the concept)
- Each section contains the FULL original text for that concept (do not summarize, do not truncate)
- Strip fenced code blocks (\`\`\`...\`\`\`), markdown tables (| ... |), JSON/YAML blocks, shell examples, and HTML tags from the content. Keep only prose text and bullet lists.
- Skip sections that would have less than 50 characters of prose after stripping
- Preserve the order of the original document
- A long H2 section with multiple sub-topics should be split into multiple sections
- A short H2 section that is part of a larger concept can be merged with adjacent sections

Respond ONLY with a JSON object. No markdown fences, no explanation.

Output format:
{ "sections": [{ "title": "...", "content": "..." }, ...] }`;

/**
 * Use Haiku to semantically chunk a doc file into sections.
 * Falls back to H2-based mechanical splitting if Haiku fails.
 */
async function chunkDocWithHaiku(
  filePath: string,
  source: string,
  model: string,
  projectRoot: string,
): Promise<DocSection[]> {
  const log = contextLogger();

  try {
    const result = await runSingleTurnQuery(
      {
        systemPrompt: CHUNK_SYSTEM_PROMPT,
        userMessage: `Document: \`${filePath}\`\n\n${source}`,
        model,
        projectRoot,
        abortController: new AbortController(),
      },
      ChunkResponseSchema,
    );

    return result.data.sections
      .filter((s) => s.content.trim().length >= 50)
      .map((s) => ({
        filePath,
        heading: s.title,
        embedText: s.content.trim(),
        content: s.content.trim(),
      }));
  } catch (err) {
    log?.warn({ file: filePath, err: String(err) }, 'doc chunking: Haiku call failed, using H2 fallback');
    return fallbackParseH2(filePath, source);
  }
}

// ---------------------------------------------------------------------------
// Fallback: mechanical H2 parsing (no LLM)
// ---------------------------------------------------------------------------

function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')     // fenced code blocks
    .replace(/`[^`\n]+`/g, '')           // inline code
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
      }
      currentHeading = h2Match[1].trim();
    } else if (currentHeading !== null) {
      contentLines.push(line);
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
}

/**
 * Parse /docs/ into semantic sections (via Haiku or H2 fallback),
 * embed prose via NLP model, and upsert as type='doc_section' cards.
 *
 * Uses SHA-256 per doc file to skip unchanged files.
 */
export async function indexDocSections(options: DocIndexOptions): Promise<number> {
  const { projectRoot, vectorStore, docsDir = 'docs', cacheSuffix = 'lite', chunkModel, onLog, onProgress, onFileStart, onFileDone } = options;

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

  const changedFiles: Array<{ relPath: string; source: string }> = [];
  let cachedCount = 0;

  for (const absPath of files) {
    const relPath = relative(projectRoot, absPath);
    const source = readFileSync(absPath, 'utf-8');
    const sha = computeDocSha(source);
    const cached = cache[relPath];

    if (cached && cached.sha === sha) {
      newCache[relPath] = cached;
      cachedCount++;
    } else {
      changedFiles.push({ relPath, source });
    }
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

  for (const { relPath, source } of changedFiles) {
    docFileCounter++;
    onProgress?.(docFileCounter, changedFiles.length);
    onFileStart?.(relPath);
    onLog(`rag: [${docFileCounter}/${changedFiles.length}] chunking ${relPath}`);
    const sha = computeDocSha(source);

    const sections = chunkModel
      ? await chunkDocWithHaiku(relPath, source, chunkModel, projectRoot)
      : fallbackParseH2(relPath, source);

    if (sections.length === 0) {
      newCache[relPath] = { sha, sectionIds: [] };
      continue;
    }

    const cards: Array<{ id: string; filePath: string; name: string; summary: string }> = [];
    const nlpEmbeddings: number[][] = [];
    const sectionIds: string[] = [];

    for (const section of sections) {
      const id = buildDocSectionId(section.filePath, section.heading);
      cards.push({ id, filePath: section.filePath, name: section.heading, summary: section.embedText.slice(0, 400) });
      sectionIds.push(id);

      nlpEmbeddings.push(await embedNlp(section.embedText));
    }

    await vectorStore.upsertDocSections(cards, nlpEmbeddings);
    newCache[relPath] = { sha, sectionIds };
    totalIndexed += sections.length;
    onLog(`rag: ${relPath} → ${sections.length} sections`);
    onFileDone?.(relPath);
  }

  saveDocCacheToRagCache(projectRoot, cacheSuffix, newCache);
  onLog(`rag: indexed ${totalIndexed} doc sections from ${changedFiles.length} files`);

  return totalIndexed;
}
