// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename, sep } from 'node:path';
import type { RelevantDoc } from './axis-evaluator.js';
import type { Config } from '../schemas/config.js';
import type { VectorStore } from '../rag/vector-store.js';

const MAX_PAGES = 3;
const MAX_LINES_PER_PAGE = 300;

// RAG-based doc matching limits
export const RAG_MAX_SECTIONS = 5;
export const RAG_MAX_LINES_PER_SECTION = 100;
export const RAG_MAX_DOC_TOKENS = 4000;

// ---------------------------------------------------------------------------
// buildDocsTree — recursive listing of docs dir as ASCII tree
// ---------------------------------------------------------------------------

/**
 * Build an ASCII tree of the docs directory. Returns null if the directory
 * doesn't exist or is empty.
 */
export function buildDocsTree(projectRoot: string, docsPath: string): string | null {
  const docsDir = join(projectRoot, docsPath);
  if (!existsSync(docsDir)) return null;

  const entries = collectMdFiles(docsDir, docsDir);
  if (entries.length === 0) return null;

  return renderTree(entries);
}

interface TreeEntry {
  relativePath: string;
  isDirectory: boolean;
}

function collectMdFiles(dir: string, rootDir: string): TreeEntry[] {
  const result: TreeEntry[] = [];
  let items: string[];
  try {
    items = readdirSync(dir).sort();
  } catch {
    return result;
  }

  for (const item of items) {
    const fullPath = join(dir, item);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    const rel = relative(rootDir, fullPath);

    if (stat.isDirectory()) {
      const children = collectMdFiles(fullPath, rootDir);
      if (children.length > 0) {
        result.push({ relativePath: rel, isDirectory: true });
        result.push(...children);
      }
    } else if (item.endsWith('.md')) {
      result.push({ relativePath: rel, isDirectory: false });
    }
  }

  return result;
}

function renderTree(entries: TreeEntry[]): string {
  const lines: string[] = [];
  // Build a simple indented tree from relative paths
  for (const entry of entries) {
    const depth = entry.relativePath.split(sep).length - 1;
    const name = basename(entry.relativePath);
    const prefix = depth > 0 ? '  '.repeat(depth) + '├── ' : '';
    lines.push(`${prefix}${entry.isDirectory ? name + '/' : name}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// resolveRelevantDocs — find relevant doc pages for a source file
// ---------------------------------------------------------------------------

/**
 * Resolve documentation pages relevant to the given source file.
 * Uses config-driven mapping first, then convention-based fallback.
 * Returns at most MAX_PAGES pages, each truncated to MAX_LINES_PER_PAGE lines.
 */
export function resolveRelevantDocs(
  filePath: string,
  docsTree: string | null,
  config: Config,
  projectRoot: string,
): RelevantDoc[] {
  if (docsTree === null) return [];

  const docsDir = join(projectRoot, config.documentation.docs_path);
  if (!existsSync(docsDir)) return [];

  const mapping = config.documentation.module_mapping;
  const docs: RelevantDoc[] = [];

  // 1. Config-driven mapping (primary) — sort longest prefix first for specificity
  if (mapping) {
    const sortedEntries = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length);
    for (const [modulePrefix, docDirs] of sortedEntries) {
      if (filePath.startsWith(modulePrefix)) {
        for (const docDir of docDirs) {
          if (docs.length >= MAX_PAGES) break;
          const resolved = findDocsInDir(docsDir, docDir);
          for (const doc of resolved) {
            if (docs.length >= MAX_PAGES) break;
            if (!docs.some((d) => d.path === doc.path)) {
              docs.push(doc);
            }
          }
        }
        if (docs.length > 0) return docs;
      }
    }
  }

  // 2. Convention-based fallback — match directory names
  const moduleDir = dirname(filePath);
  const segments = moduleDir.split(sep).filter(Boolean);

  const allDocDirs = listDocDirs(docsDir);
  for (const docDir of allDocDirs) {
    if (docs.length >= MAX_PAGES) break;
    const normalized = normalizeDocDirName(docDir);
    if (segments.some((seg) => normalized.includes(seg))) {
      const resolved = findDocsInDir(docsDir, docDir);
      for (const doc of resolved) {
        if (docs.length >= MAX_PAGES) break;
        if (!docs.some((d) => d.path === doc.path)) {
          docs.push(doc);
        }
      }
    }
  }

  return docs;
}

/**
 * Strip numbered prefixes like "04-" from doc directory names and lowercase.
 */
function normalizeDocDirName(name: string): string {
  return name.replace(/^\d+-/, '').toLowerCase().replace(/-/g, ' ');
}

/**
 * List top-level subdirectory names in the docs dir.
 */
function listDocDirs(docsDir: string): string[] {
  try {
    return readdirSync(docsDir)
      .filter((name) => {
        try {
          return statSync(join(docsDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find all .md files in a docs subdirectory and load their content (truncated).
 */
function findDocsInDir(docsDir: string, subDir: string): RelevantDoc[] {
  const dir = join(docsDir, subDir);
  if (!existsSync(dir)) return [];

  const docs: RelevantDoc[] = [];
  let items: string[];
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) {
      // subDir is a file name
      if (dir.endsWith('.md')) {
        return [loadDoc(dir, docsDir)].filter((d): d is RelevantDoc => d !== null);
      }
      return [];
    }
    items = readdirSync(dir).sort();
  } catch {
    return [];
  }

  for (const item of items) {
    if (!item.endsWith('.md')) continue;
    const fullPath = join(dir, item);
    const doc = loadDoc(fullPath, docsDir);
    if (doc) docs.push(doc);
  }

  return docs;
}

function loadDoc(fullPath: string, docsDir: string): RelevantDoc | null {
  try {
    const raw = readFileSync(fullPath, 'utf-8');
    const lines = raw.split('\n');
    const truncated = lines.length > MAX_LINES_PER_PAGE
      ? lines.slice(0, MAX_LINES_PER_PAGE).join('\n') + `\n\n<!-- truncated at ${MAX_LINES_PER_PAGE} lines -->`
      : raw;
    return {
      path: relative(docsDir, fullPath),
      content: truncated,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// resolveRelevantDocsViaRag — semantic doc matching using RAG NLP search
// ---------------------------------------------------------------------------

/**
 * Resolve documentation sections relevant to a source file using RAG NLP search.
 * Matches function summaries from the vector store against indexed doc sections.
 *
 * Falls back to file-path-based query when no function summaries are available.
 * Applies RAG_MAX_SECTIONS, RAG_MAX_LINES_PER_SECTION, and RAG_MAX_DOC_TOKENS limits.
 */
export async function resolveRelevantDocsViaRag(
  filePath: string,
  vectorStore: VectorStore,
  projectRoot: string,
): Promise<RelevantDoc[]> {
  // 1. Use the pre-computed average NLP vector for this file's functions
  //    No runtime embedding needed — vectors are already in LanceDB from the RAG phase.
  const queryEmbedding = await vectorStore.getAverageNlpVectorByFile(filePath);
  if (!queryEmbedding) return [];

  // 2. Search doc sections by similarity
  const results = await vectorStore.searchDocSections(queryEmbedding, RAG_MAX_SECTIONS);

  if (results.length === 0) return [];

  // 3. Load full section content from disk and apply limits
  const docs: RelevantDoc[] = [];
  let totalChars = 0;
  const maxChars = RAG_MAX_DOC_TOKENS * 4; // ~4 chars per token

  for (const result of results) {
    if (docs.length >= RAG_MAX_SECTIONS) break;

    const content = loadDocSection(
      projectRoot,
      result.card.filePath,
      result.card.name,
      RAG_MAX_LINES_PER_SECTION,
    );

    if (!content) continue;

    // Check total token budget
    if (totalChars + content.length > maxChars) {
      const remaining = maxChars - totalChars;
      if (remaining < 100) break;
      docs.push({
        path: result.card.filePath,
        content: content.slice(0, remaining) + '\n<!-- truncated to fit token budget -->',
      });
      break;
    }

    totalChars += content.length;
    docs.push({ path: result.card.filePath, content });
  }

  return docs;
}

/**
 * Load a specific H2 section from a doc file by heading text.
 * Returns the section content (up to maxLines) or null if not found.
 */
function loadDocSection(
  projectRoot: string,
  filePath: string,
  heading: string,
  maxLines: number,
): string | null {
  const absPath = join(projectRoot, filePath);
  if (!existsSync(absPath)) return null;

  try {
    const source = readFileSync(absPath, 'utf-8');
    const lines = source.split('\n');

    // Find the H2 heading
    let startLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^##\s+(.+)/);
      if (match && match[1].trim() === heading) {
        startLine = i;
        break;
      }
    }

    if (startLine < 0) return null;

    // Find the end of the section (next H2 or EOF)
    let endLine = lines.length;
    for (let i = startLine + 1; i < lines.length; i++) {
      if (lines[i].match(/^##\s+/)) {
        endLine = i;
        break;
      }
    }

    const cappedEnd = Math.min(endLine, startLine + maxLines);
    const sectionLines = lines.slice(startLine, cappedEnd);
    const content = sectionLines.join('\n').trim();

    if (endLine - startLine > maxLines) {
      return content + `\n<!-- truncated at ${maxLines} lines -->`;
    }

    return content;
  } catch {
    return null;
  }
}
