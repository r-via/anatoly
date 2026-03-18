// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename, sep } from 'node:path';
import type { RelevantDoc } from './axis-evaluator.js';
import type { Config } from '../schemas/config.js';

const MAX_PAGES = 3;
const MAX_LINES_PER_PAGE = 300;

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
