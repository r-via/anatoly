import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Task } from '../schemas/task.js';
import type { FunctionCardLLMOutput } from './types.js';
import { FunctionCardLLMOutputSchema } from './types.js';
import { z } from 'zod';
import { extractJson } from '../utils/extract-json.js';
import { isRateLimitError } from '../utils/rate-limiter.js';

const CardResponseSchema = z.object({
  function_cards: z.array(FunctionCardLLMOutputSchema),
});

/**
 * Generate FunctionCards for all functions/methods/hooks in a file.
 * This is a fast, cheap call — no tools, just prompt → JSON.
 */
export async function generateFunctionCards(
  projectRoot: string,
  task: Task,
  model: string,
): Promise<FunctionCardLLMOutput[]> {
  const functionSymbols = task.symbols.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
  );

  if (functionSymbols.length === 0) return [];

  const absPath = resolve(projectRoot, task.file);
  let source: string;
  try {
    source = readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }

  const symbolList = functionSymbols
    .map((s) => `- ${s.name} (L${s.line_start}–L${s.line_end})`)
    .join('\n');

  const systemPrompt = `You generate concise function summaries for a code indexing system.
Output ONLY a JSON object with a "function_cards" array. No markdown fences, no explanation.

For each function listed below, produce:
- name: exact function name
- summary: 1-2 sentence conceptual summary (max 400 chars). Describe WHAT it does, not HOW.
- keyConcepts: 3-6 keywords describing behavior, domain, and purpose
- behavioralProfile: one of "pure", "sideEffectful", "async", "memoized", "stateful", "utility"

Functions to document:
${symbolList}`;

  const userPrompt = `\`\`\`typescript
${source}
\`\`\``;

  try {
    const q = query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        model,
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    });

    let resultText = '';
    for await (const message of q) {
      if (message.type === 'result' && message.subtype === 'success') {
        resultText = (message as SDKResultSuccess).result;
      }
    }

    if (!resultText) return [];

    const parsed = extractJson(resultText);
    if (!parsed) return [];

    const result = CardResponseSchema.safeParse(JSON.parse(parsed));
    if (!result.success) return [];

    return result.data.function_cards;
  } catch (error) {
    // Re-throw rate limit errors so retryWithBackoff can handle them
    if (isRateLimitError(error)) throw error;
    return [];
  }
}
