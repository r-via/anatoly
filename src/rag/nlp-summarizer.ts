// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { FunctionCard } from './types.js';
import { BehavioralProfileSchema } from './types.js';
import { runSingleTurnQuery } from '../core/axis-evaluator.js';
import type { Semaphore } from '../core/sdk-semaphore.js';
import { contextLogger, runWithContext } from '../utils/log-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NlpSummary {
  summary: string;
  keyConcepts: string[];
  behavioralProfile: FunctionCard['behavioralProfile'];
}

const NlpFunctionSchema = z.object({
  name: z.string(),
  summary: z.string().max(400),
  keyConcepts: z.array(z.string()).min(1).max(7),
  behavioralProfile: BehavioralProfileSchema,
});

const NlpResponseSchema = z.object({
  functions: z.array(NlpFunctionSchema),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a code documentation assistant. For each function provided, generate:
- summary: A concise natural language description of what the function does and WHY (max 400 chars). Focus on intent and behavior, not implementation details.
- keyConcepts: 3-7 semantic keywords describing the function's domain, purpose, and patterns (e.g. "caching", "authentication", "data-transformation", "error-handling").
- behavioralProfile: One of: pure, sideEffectful, async, memoized, stateful, utility.

Respond ONLY with a JSON object. No markdown fences, no explanation.`;

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
): Promise<Map<string, NlpSummary>> {
  const result = new Map<string, NlpSummary>();
  if (cards.length === 0) return result;

  const log = contextLogger();
  const userMessage = buildUserMessage(filePath, cards, functionBodies);

  try {
    const fileSlug = filePath.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '-');
    const response = await runWithContext({ axis: 'nlp-summary' }, () => runSingleTurnQuery(
      {
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
        model,
        projectRoot,
        abortController: new AbortController(),
        conversationDir,
        conversationPrefix: conversationDir ? `rag__nlp-summary__${fileSlug}` : undefined,
        semaphore,
      },
      NlpResponseSchema,
    ));

    // Match response functions to cards by name
    for (const fn of response.data.functions) {
      const card = cards.find((c) => c.name === fn.name);
      if (card) {
        result.set(card.id, {
          summary: fn.summary,
          keyConcepts: fn.keyConcepts,
          behavioralProfile: fn.behavioralProfile,
        });
      }
    }
  } catch (err) {
    log.warn({ filePath, err: String(err) }, 'NLP summarization call failed');
  }

  return result;
}
