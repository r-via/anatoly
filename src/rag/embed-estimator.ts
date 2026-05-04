// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { globSync } from 'tinyglobby';
import { get_encoding } from 'tiktoken';
import type { Task } from '../schemas/task.js';
import { extractFunctionBody, extractSignature } from './indexer.js';
import { buildEmbedCode } from './embeddings.js';
import { smartChunkDoc } from './doc-indexer.js';

/**
 * Approximated token cost per function for NLP embeddings (summary +
 * key concepts + behavioral profile, plus a parallel doc-summary embed).
 * NLP summaries don't exist before the run, so we use a flat per-symbol
 * average derived from observed Anatoly NLP outputs (~80-120 tokens each,
 * x2 for summary + doc embed).
 */
const NLP_TOKENS_PER_FUNCTION = 200;

export interface EmbedEstimate {
  /** Total tokens sent to the code-embedding model. */
  codeTokens: number;
  /** Number of code embedding calls (one per function/method/hook). */
  codeUnits: number;
  /** Total tokens sent to the NLP-embedding model (summaries + doc chunks). */
  nlpTokens: number;
  /** Number of NLP embedding calls (function summaries + doc chunks). */
  nlpUnits: number;
}

/**
 * Estimate the number of tokens that would be sent to the embedding models
 * during a full RAG indexing pass. Uses cl100k_base tokenizer as a proxy —
 * accurate to within ~10% for most external embedding providers (Voyage,
 * Nomic, Qwen, Jina) on code and English prose.
 *
 * Code tokens are computed exactly (file is read, function body extracted,
 * embed text built, encoded). NLP tokens combine an approximation for
 * function summaries (which don't exist pre-run) with exact counts on
 * smart-chunked doc sections.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param tasks - Scanned task list (one per source file).
 * @param docsPaths - Doc directories to chunk and count. Defaults to
 *   `['docs', '.anatoly/docs']` matching the standard RAG pipeline.
 * @returns Token and unit counts split by embedding model role.
 */
export function estimateEmbedTokens(
  projectRoot: string,
  tasks: Task[],
  docsPaths: string[] = ['docs', join('.anatoly', 'docs')],
): EmbedEstimate {
  const enc = get_encoding('cl100k_base');
  let codeTokens = 0;
  let codeUnits = 0;
  let docTokens = 0;
  let docChunks = 0;
  let functionSymbolCount = 0;

  try {
    for (const task of tasks) {
      const absPath = resolve(projectRoot, task.file);
      let source: string;
      try {
        source = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }
      const fnSymbols = task.symbols.filter(
        (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
      );
      for (const symbol of fnSymbols) {
        const signature = extractSignature(source, symbol);
        const body = extractFunctionBody(source, symbol);
        const text = buildEmbedCode(symbol.name, signature, body);
        codeTokens += enc.encode(text).length;
        codeUnits++;
      }
      functionSymbolCount += fnSymbols.length;
    }

    for (const docsDir of docsPaths) {
      const absDocsDir = resolve(projectRoot, docsDir);
      if (!existsSync(absDocsDir)) continue;
      const files = globSync(['**/*.md'], { cwd: absDocsDir, absolute: true });
      for (const absPath of files) {
        try {
          const content = readFileSync(absPath, 'utf-8');
          const sections = smartChunkDoc(absPath, content);
          for (const section of sections) {
            docTokens += enc.encode(section.embedText).length;
            docChunks++;
          }
        } catch { /* skip unreadable doc */ }
      }
    }

    const nlpTokens = functionSymbolCount * NLP_TOKENS_PER_FUNCTION + docTokens;
    const nlpUnits = functionSymbolCount * 2 + docChunks;

    return { codeTokens, codeUnits, nlpTokens, nlpUnits };
  } finally {
    enc.free();
  }
}
