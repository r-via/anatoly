// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename, sep, extname } from 'node:path';
import type { RelevantDoc } from './axis-evaluator.js';
import type { Config } from '../schemas/config.js';
import type { VectorStore } from '../rag/vector-store.js';
import { embedNlp } from '../rag/embeddings.js';

const MAX_PAGES = 3;
const MAX_LINES_PER_PAGE = 300;

// RAG-based doc matching limits
export const RAG_MAX_SECTIONS = 5;
export const RAG_MAX_LINES_PER_SECTION = 100;

/** Doc injection budget = 20% of model context window. */
export const DOC_BUDGET_RATIO = 0.20;

/** Model context window sizes (tokens). */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Compute max doc tokens from model context window (20% of window). */
export function getDocTokenBudget(model?: string): number {
  const window = (model && MODEL_CONTEXT_WINDOWS[model]) ?? DEFAULT_CONTEXT_WINDOW;
  return Math.round(window * DOC_BUDGET_RATIO);
}

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
  opts?: { docsDir?: string; source?: 'project' | 'internal' },
): RelevantDoc[] {
  if (docsTree === null) return [];

  const docsDir = opts?.docsDir ?? join(projectRoot, config.documentation.docs_path);
  if (!existsSync(docsDir)) return [];

  const source = opts?.source;
  const mapping = config.documentation.module_mapping;
  const docs: RelevantDoc[] = [];

  const tagDoc = (doc: RelevantDoc): RelevantDoc =>
    source ? { ...doc, source } : doc;

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
              docs.push(tagDoc(doc));
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
          docs.push(tagDoc(doc));
        }
      }
    }
  }

  return docs;
}

/**
 * Resolve docs from both project (docs/) and internal (.anatoly/docs/) sources.
 * Merges results with source tags, interleaving to give equal representation.
 */
export function resolveAllRelevantDocs(
  filePath: string,
  config: Config,
  projectRoot: string,
  opts: {
    docsTree: string | null;
    internalDocsTree: string | null;
    internalDocsDir: string;
  },
): RelevantDoc[] {
  const projectDocs = resolveRelevantDocs(filePath, opts.docsTree, config, projectRoot, {
    source: 'project',
  });

  const internalDocs = resolveRelevantDocs(filePath, opts.internalDocsTree, config, projectRoot, {
    docsDir: opts.internalDocsDir,
    source: 'internal',
  });

  // Merge: interleave for equal representation, cap at MAX_PAGES total
  const merged: RelevantDoc[] = [];
  const pi = [...projectDocs];
  const ii = [...internalDocs];
  while (merged.length < MAX_PAGES && (pi.length > 0 || ii.length > 0)) {
    if (pi.length > 0) merged.push(pi.shift()!);
    if (merged.length < MAX_PAGES && ii.length > 0) merged.push(ii.shift()!);
  }

  return merged;
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
 * Uses pre-computed NLP vectors from LanceDB when available (no runtime embedding needed).
 * Falls back to ONNX embedNlp with file name as query when no pre-computed vectors exist.
 * Doc token budget = 20% of model context window, split equally between project/internal sources.
 */
export async function resolveRelevantDocsViaRag(
  filePath: string,
  vectorStore: VectorStore,
  projectRoot: string,
  model?: string,
): Promise<RelevantDoc[]> {
  // 1. Try pre-computed average NLP vector (no runtime embedding needed)
  let queryEmbedding = await vectorStore.getAverageNlpVectorByFile(filePath);

  // Fallback: embed file name via ONNX (works in lite mode without containers)
  if (!queryEmbedding) {
    try {
      queryEmbedding = await embedNlp(`Module: ${basename(filePath, extname(filePath))}`);
    } catch {
      return [];
    }
  }

  // 2. Search doc sections by similarity
  const results = await vectorStore.searchDocSections(queryEmbedding, RAG_MAX_SECTIONS);

  if (results.length === 0) return [];

  // 3. Load full section content from disk and apply limits
  // Budget = 20% of model context window, split between project and internal sources
  const totalBudgetTokens = getDocTokenBudget(model);
  const docs: RelevantDoc[] = [];
  const halfMaxChars = totalBudgetTokens * 2; // ~half budget per source (4 chars/token, /2 sources)
  let projectChars = 0;
  let internalChars = 0;

  for (const result of results) {
    if (docs.length >= RAG_MAX_SECTIONS) break;

    const content = loadDocSection(
      projectRoot,
      result.card.filePath,
      result.card.name,
      RAG_MAX_LINES_PER_SECTION,
    );

    if (!content) continue;

    // Infer source from file path
    const source: 'project' | 'internal' = result.card.filePath.startsWith('.anatoly/')
      ? 'internal'
      : 'project';

    // Check per-source token budget
    const usedChars = source === 'project' ? projectChars : internalChars;
    if (usedChars + content.length > halfMaxChars) {
      const remaining = halfMaxChars - usedChars;
      if (remaining < 100) continue; // skip this source, try next result
      docs.push({
        path: result.card.filePath,
        content: content.slice(0, remaining) + '\n<!-- truncated to fit token budget -->',
        source,
      });
      if (source === 'project') projectChars = halfMaxChars;
      else internalChars = halfMaxChars;
      continue;
    }

    if (source === 'project') projectChars += content.length;
    else internalChars += content.length;
    docs.push({ path: result.card.filePath, content, source });
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
