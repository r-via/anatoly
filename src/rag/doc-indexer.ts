// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { globSync } from 'tinyglobby';
import { embedNlp } from './embeddings.js';
import type { VectorStore } from './vector-store.js';

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
  onLog: (message: string) => void;
}

/**
 * Parse /docs/ into H2 sections, embed prose via NLP model,
 * and upsert as type='doc_section' cards in the vector store.
 *
 * Returns the number of doc sections indexed.
 */
export async function indexDocSections(options: DocIndexOptions): Promise<number> {
  const { projectRoot, vectorStore, docsDir = 'docs', onLog } = options;

  const sections = collectDocSections(projectRoot, docsDir);
  if (sections.length === 0) {
    onLog('rag: no doc sections found');
    return 0;
  }

  onLog(`rag: indexing ${sections.length} doc sections from ${docsDir}/`);

  // Build card-like records and NLP embeddings
  const cards: Array<{ id: string; filePath: string; name: string; summary: string }> = [];
  const nlpEmbeddings: number[][] = [];

  for (const section of sections) {
    const id = buildDocSectionId(section.filePath, section.heading);
    // Truncate content for summary field (max ~400 chars)
    const summary = section.content.slice(0, 400);
    cards.push({ id, filePath: section.filePath, name: section.heading, summary });

    // Embed the full prose content via NLP model
    const embedText = `${section.heading}\n${section.content}`;
    nlpEmbeddings.push(await embedNlp(embedText));
  }

  await vectorStore.upsertDocSections(cards, nlpEmbeddings);
  onLog(`rag: indexed ${sections.length} doc sections`);

  return sections.length;
}
