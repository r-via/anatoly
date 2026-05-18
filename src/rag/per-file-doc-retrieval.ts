// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Per-file reference-doc retrieval — replaces the lite-mode digest with
 * targeted RAG lookups in the `correction`, `best-practices`, and
 * `overengineering` axes.
 *
 * Strategy (deterministic, no LLM):
 *   1. Embed the file under review (via its pre-computed NLP vector when the
 *      RAG index has one; otherwise via an on-the-fly ONNX embedding of the
 *      module name).
 *   2. Query the doc-section vector store for the top-K matches.
 *   3. For each match, expand it to its H2 neighbourhood: include the H2
 *      block whose heading matched, plus the one before and the one after.
 *      This mirrors how a human skims docs (look at the matched section, then
 *      glance up and down for context) without injecting the whole file.
 *   4. Dedupe overlapping neighbourhoods by `(filePath, heading)`.
 *   5. Return a {@link ReferenceDoc}[] consumable by
 *      `renderReferenceDocsContext`.
 *
 * The vector-store call carries a {@link RagQueryContext} so each retrieval is
 * traceable in the per-run `anatoly.ndjson` (caller, file, axis, args,
 * latency, top hit). This is the per-axis substitute for the consolidated
 * lite digest: no upfront budget, no truncation, no fixed cost — pay only for
 * what each axis actually needs to see.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { embedNlp } from './embeddings.js';
import type { RagQueryContext, VectorStore } from './vector-store.js';
import type { ReferenceDoc } from '../core/documentation/index.js';

interface H2Block {
  heading: string;
  /** Full text of the section: the heading line plus everything until the next H2 (or EOF). */
  content: string;
}

/**
 * Parse a Markdown source into its sequence of H2 blocks.
 * The block at index `i` contains the heading line, the blank line that
 * usually follows, and all subsequent lines until the next H2 or EOF.
 * Content before the first H2 (preamble) is intentionally not surfaced
 * here — it is not addressable by an H2 heading.
 */
export function parseH2Blocks(source: string): H2Block[] {
  const lines = source.split('\n');
  const blocks: H2Block[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/);
    if (m) {
      if (currentHeading !== null) {
        blocks.push({ heading: currentHeading, content: currentLines.join('\n') });
      }
      currentHeading = m[1].trim();
      currentLines = [line];
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  if (currentHeading !== null) {
    blocks.push({ heading: currentHeading, content: currentLines.join('\n') });
  }

  return blocks;
}

/**
 * Load a Markdown file and return the matched H2 block plus its immediate
 * neighbours (previous + matched + next), concatenated. Returns `null` when
 * the file is missing or the heading is not found.
 */
export function loadH2Neighborhood(
  projectRoot: string,
  filePath: string,
  heading: string,
): string | null {
  const absPath = join(projectRoot, filePath);
  if (!existsSync(absPath)) return null;

  let source: string;
  try {
    source = readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }

  const blocks = parseH2Blocks(source);
  const idx = blocks.findIndex((b) => b.heading === heading);
  if (idx < 0) return null;

  const start = Math.max(0, idx - 1);
  const end = Math.min(blocks.length - 1, idx + 1);
  const slice = blocks.slice(start, end + 1);
  return slice.map((b) => b.content.trimEnd()).join('\n\n');
}

/** Classify a doc path into the `ReferenceDoc.source` value the renderer expects. */
function classifyDocSource(filePath: string): 'readme' | 'spec' | 'md' {
  const base = basename(filePath).toLowerCase();
  if (base === 'readme.md') return 'readme';
  if (filePath.startsWith('specs/') || filePath.startsWith('specs\\')) return 'spec';
  return 'md';
}

export interface RetrieveDocsForFileOptions {
  /** Top-K matches to retrieve from the vector store. Default `3`. */
  k?: number;
  /** Minimum cosine similarity for a match to be considered. Default `0.5`. */
  minScore?: number;
}

/**
 * Retrieve reference docs relevant to a specific source file via RAG.
 *
 * @param filePath       Relative path of the source file under review.
 * @param vectorStore    Initialised LanceDB-backed store with `doc_section` rows.
 * @param projectRoot    Absolute project root used to load the matched H2 blocks from disk.
 * @param context        Origin of the query — surfaced in the `rag.query` audit-trail event.
 * @param options        Retrieval tuning.
 * @returns              An array of {@link ReferenceDoc} ready to inject into `ctx.referenceDocs`.
 *                       Empty when the store has no matches or the file's embedding is unavailable.
 */
export async function retrieveRelevantDocsForFile(
  filePath: string,
  vectorStore: VectorStore,
  projectRoot: string,
  context: RagQueryContext,
  options: RetrieveDocsForFileOptions = {},
): Promise<ReferenceDoc[]> {
  const k = options.k ?? 3;
  const minScore = options.minScore ?? 0.5;

  let queryEmbedding = await vectorStore.getAverageNlpVectorByFile(filePath);
  if (!queryEmbedding) {
    try {
      queryEmbedding = await embedNlp(`Module: ${basename(filePath, extname(filePath))}`);
    } catch {
      return [];
    }
  }

  // Query the doc-section index. The caller context flows into the
  // `rag.query` audit-trail event emitted by the vector store.
  const results = await vectorStore.searchDocSections(queryEmbedding, k, minScore, undefined, context);
  if (results.length === 0) return [];

  // Expand each match to its H2 neighbourhood. Dedupe matches that resolve to
  // the same `(filePath, heading)` so we don't inject the same chunk twice
  // (can happen when several axes drive the same retrieval shape).
  const seen = new Set<string>();
  const docs: ReferenceDoc[] = [];

  for (const result of results) {
    const docFilePath = result.card.filePath;
    const heading = result.card.name;
    const key = `${docFilePath}:::${heading}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const content = loadH2Neighborhood(projectRoot, docFilePath, heading);
    if (!content) continue;

    docs.push({
      source: classifyDocSource(docFilePath),
      path: docFilePath,
      content,
    });
  }

  return docs;
}
