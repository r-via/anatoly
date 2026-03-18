// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { globSync } from 'tinyglobby';
import { embedNlp } from './embeddings.js';
import type { VectorStore } from './vector-store.js';

// ---------------------------------------------------------------------------
// Doc section cache (SHA-256 per doc file)
// ---------------------------------------------------------------------------

interface DocCacheEntry {
  /** SHA-256 of the full doc file content. */
  sha: string;
  /** Section IDs indexed from this file. */
  sectionIds: string[];
}

interface DocCache {
  entries: Record<string, DocCacheEntry>;
}

function docCachePath(projectRoot: string, suffix: string): string {
  return resolve(projectRoot, '.anatoly', 'rag', `doc_cache_${suffix}.json`);
}

function computeDocSha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function loadDocCache(projectRoot: string, suffix: string): DocCache {
  const path = docCachePath(projectRoot, suffix);
  if (!existsSync(path)) return { entries: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { entries: {} };
  }
}

export function saveDocCache(projectRoot: string, suffix: string, cache: DocCache): void {
  const path = docCachePath(projectRoot, suffix);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocSection {
  /** Relative path to the doc file (from project root). */
  filePath: string;
  /** H2 heading text (without the ## prefix). */
  heading: string;
  /** Prose-only content (code blocks stripped). */
  content: string;
  /** Line number of the H2 heading (1-based). */
  lineStart: number;
  /** Last line number of the section (1-based). */
  lineEnd: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Strip fenced code blocks from markdown text, keeping only prose.
 */
export function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
}

/**
 * Build a deterministic 16-char hex ID for a doc section.
 */
export function buildDocSectionId(filePath: string, heading: string): string {
  const input = `doc:${filePath}:${heading}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Parse a markdown file into H2 sections.
 * Each section runs from one ## heading to the next ## heading (or EOF).
 */
export function parseDocSections(filePath: string, source: string): DocSection[] {
  const sections: DocSection[] = [];
  const lines = source.split('\n');

  let currentHeading: string | null = null;
  let currentLineStart = 0;
  const contentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2Match = line.match(/^##\s+(.+)/);

    if (h2Match) {
      // Flush previous section
      if (currentHeading !== null) {
        const rawContent = contentLines.join('\n').trim();
        const prose = stripCodeBlocks(rawContent).trim();
        if (prose.length > 0) {
          sections.push({
            filePath,
            heading: currentHeading,
            content: prose,
            lineStart: currentLineStart,
            lineEnd: i, // line before this heading
          });
        }
        contentLines.length = 0;
      }

      currentHeading = h2Match[1].trim();
      currentLineStart = i + 1; // 1-based
    } else if (currentHeading !== null) {
      // Skip H3+ headings from content lines but include their text
      contentLines.push(line);
    }
  }

  // Flush last section
  if (currentHeading !== null) {
    const rawContent = contentLines.join('\n').trim();
    const prose = stripCodeBlocks(rawContent).trim();
    if (prose.length > 0) {
      sections.push({
        filePath,
        heading: currentHeading,
        content: prose,
        lineStart: currentLineStart,
        lineEnd: lines.length,
      });
    }
  }

  return sections;
}

/**
 * Collect all markdown files from the docs directory and parse them into sections.
 */
export function collectDocSections(projectRoot: string, docsDir: string = 'docs'): DocSection[] {
  const absDocsDir = resolve(projectRoot, docsDir);
  if (!existsSync(absDocsDir)) return [];

  const files = globSync(['**/*.md'], { cwd: absDocsDir, absolute: true });
  const sections: DocSection[] = [];

  for (const absPath of files) {
    const relPath = relative(projectRoot, absPath);
    const source = readFileSync(absPath, 'utf-8');
    sections.push(...parseDocSections(relPath, source));
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
  onLog: (message: string) => void;
}

/**
 * Parse /docs/ into H2 sections, embed prose via NLP model,
 * and upsert as type='doc_section' cards in the vector store.
 *
 * Uses SHA-256 per doc file to skip unchanged files.
 * When a file changes, all its old sections are removed and new ones are indexed.
 *
 * Returns the number of NEW doc sections indexed (0 = all cached).
 */
export async function indexDocSections(options: DocIndexOptions): Promise<number> {
  const { projectRoot, vectorStore, docsDir = 'docs', cacheSuffix = 'lite', onLog } = options;

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

  const cache = loadDocCache(projectRoot, cacheSuffix);
  const newCache: DocCache = { entries: {} };

  // Determine which files changed
  const changedFiles: Array<{ relPath: string; source: string }> = [];
  let cachedCount = 0;

  for (const absPath of files) {
    const relPath = relative(projectRoot, absPath);
    const source = readFileSync(absPath, 'utf-8');
    const sha = computeDocSha(source);
    const cached = cache.entries[relPath];

    if (cached && cached.sha === sha) {
      // Unchanged — carry forward cache entry
      newCache.entries[relPath] = cached;
      cachedCount++;
    } else {
      changedFiles.push({ relPath, source });
    }
  }

  // Remove stale sections for deleted/changed files
  const staleFiles = Object.keys(cache.entries).filter(f => !newCache.entries[f]);
  for (const staleFile of staleFiles) {
    const staleIds = cache.entries[staleFile]?.sectionIds ?? [];
    if (staleIds.length > 0) {
      await vectorStore.deleteDocSections(staleIds);
    }
  }

  if (changedFiles.length === 0) {
    onLog(`rag: doc sections up to date (${cachedCount} files cached)`);
    saveDocCache(projectRoot, cacheSuffix, newCache);
    return 0;
  }

  onLog(`rag: indexing doc sections from ${changedFiles.length} changed files (${cachedCount} cached)`);

  let totalIndexed = 0;

  for (const { relPath, source } of changedFiles) {
    const sha = computeDocSha(source);
    const sections = parseDocSections(relPath, source);

    if (sections.length === 0) {
      newCache.entries[relPath] = { sha, sectionIds: [] };
      continue;
    }

    const cards: Array<{ id: string; filePath: string; name: string; summary: string }> = [];
    const nlpEmbeddings: number[][] = [];
    const sectionIds: string[] = [];

    for (const section of sections) {
      const id = buildDocSectionId(section.filePath, section.heading);
      const summary = section.content.slice(0, 400);
      cards.push({ id, filePath: section.filePath, name: section.heading, summary });
      sectionIds.push(id);

      const embedText = `${section.heading}\n${section.content}`;
      nlpEmbeddings.push(await embedNlp(embedText));
    }

    await vectorStore.upsertDocSections(cards, nlpEmbeddings);
    newCache.entries[relPath] = { sha, sectionIds };
    totalIndexed += sections.length;
  }

  saveDocCache(projectRoot, cacheSuffix, newCache);
  onLog(`rag: indexed ${totalIndexed} doc sections from ${changedFiles.length} files`);

  return totalIndexed;
}
