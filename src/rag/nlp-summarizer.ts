// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { FunctionCard } from './types.js';
import { BehavioralProfileSchema } from './types.js';
import { runSingleTurnQuery } from '../core/axis-evaluator.js';
import type { Semaphore } from '../core/sdk-semaphore.js';
import { contextLogger, runWithContext } from '../utils/log-context.js';
import { resolveSystemPrompt } from '../core/prompt-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NlpSummary {
  summary: string;
  docSummary: string;
  keyConcepts: string[];
  behavioralProfile: FunctionCard['behavioralProfile'];
}

const NlpFunctionSchema = z.object({
  name: z.string(),
  summary: z.string().transform(s => s.slice(0, 400)),
  docSummary: z.string().transform(s => s.slice(0, 400)).optional().default(''),
  keyConcepts: z.array(z.string()).min(1).max(7),
  behavioralProfile: BehavioralProfileSchema,
});

const NlpResponseSchema = z.object({
  functions: z.array(NlpFunctionSchema),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function getNlpSystemPrompt(): string {
  return resolveSystemPrompt('rag.nlp-summarizer');
}

/**
 * Build the user-message prompt sent to the NLP summarization model.
 *
 * Each function body is truncated to 2 000 characters. When a body is missing
 * from `functionBodies` (index gap), the card's `signature` is used as a fallback.
 *
 * @param filePath       - Source file path included as context in the prompt header.
 * @param cards          - Function cards to summarize.
 * @param functionBodies - Parallel array of raw function bodies (same order as `cards`).
 * @returns The assembled prompt string ready for the LLM user message.
 */
function buildUserMessage(filePath: string, cards: FunctionCard[], functionBodies: string[]): string {
  const parts: string[] = [];
  parts.push(`File: \`${filePath}\``);
  parts.push('');

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const body = functionBodies[i] ?? card.signature;
    parts.push(`### ${card.name}`);
    parts.push('```typescript');
    parts.push(body.slice(0, 2000));
    parts.push('```');
    parts.push('');
  }

  parts.push('Output format:');
  parts.push('{"functions": [{"name": "...", "summary": "...", "keyConcepts": [...], "behavioralProfile": "..."}]}');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate NLP summaries for a batch of function cards from the same file.
 * Uses a single LLM call per file to generate all summaries efficiently.
 *
 * Returns a map of card.id → NlpSummary. Cards that fail summarization
 * are silently omitted from the result (the caller falls back to code-only).
 */
export async function generateNlpSummaries(
  cards: FunctionCard[],
  functionBodies: string[],
  filePath: string,
  model: string,
  projectRoot: string,
  conversationDir?: string,
  semaphore?: Semaphore,
  geminiSemaphore?: Semaphore,
): Promise<{ summaries: Map<string, NlpSummary>; costUsd: number }> {
  const summaries = new Map<string, NlpSummary>();
  if (cards.length === 0) return { summaries, costUsd: 0 };

  const log = contextLogger();
  const userMessage = buildUserMessage(filePath, cards, functionBodies);
  let costUsd = 0;

  try {
    const fileSlug = filePath.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '-');
    const response = await runWithContext({ axis: 'nlp-summary' }, () => runSingleTurnQuery(
      {
        systemPrompt: getNlpSystemPrompt(),
        userMessage,
        model,
        projectRoot,
        abortController: new AbortController(),
        conversationDir,
        conversationPrefix: conversationDir ? `rag__nlp-summary__${fileSlug}` : undefined,
        semaphore,
        geminiSemaphore,
      },
      NlpResponseSchema,
    ));

    costUsd = response.costUsd;

    // Match response functions to cards by name
    for (const fn of response.data.functions) {
      const card = cards.find((c) => c.name === fn.name);
      if (card) {
        summaries.set(card.id, {
          summary: fn.summary,
          docSummary: fn.docSummary ?? '',
          keyConcepts: fn.keyConcepts,
          behavioralProfile: fn.behavioralProfile,
        });
      }
    }
  } catch (err) {
    log.warn({ filePath, err: String(err) }, 'NLP summarization call failed');
  }

  return { summaries, costUsd };
}
