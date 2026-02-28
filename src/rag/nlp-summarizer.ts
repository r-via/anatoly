import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultSuccess, SDKResultError } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { FunctionCard } from './types.js';
import { BehavioralProfileSchema } from './types.js';
import { extractJson } from '../utils/extract-json.js';
import { contextLogger } from '../utils/log-context.js';

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
): Promise<Map<string, NlpSummary>> {
  const result = new Map<string, NlpSummary>();
  if (cards.length === 0) return result;

  const log = contextLogger();
  const userMessage = buildUserMessage(filePath, cards, functionBodies);

  try {
    const responseText = await execNlpQuery(userMessage, model, projectRoot);
    const jsonStr = extractJson(responseText);
    if (!jsonStr) {
      log.warn({ filePath, reason: 'no JSON in response' }, 'NLP summarization failed');
      return result;
    }

    const parsed = NlpResponseSchema.safeParse(JSON.parse(jsonStr));
    if (!parsed.success) {
      log.warn({ filePath, errors: parsed.error.issues.length }, 'NLP summarization validation failed');
      return result;
    }

    // Match response functions to cards by name
    for (const fn of parsed.data.functions) {
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

// ---------------------------------------------------------------------------
// Internal: lightweight SDK query for summarization
// ---------------------------------------------------------------------------

async function execNlpQuery(
  prompt: string,
  model: string,
  projectRoot: string,
): Promise<string> {
  const q = query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      cwd: projectRoot,
      allowedTools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  });

  let resultText = '';

  for await (const message of q) {
    if (message.type === 'result') {
      if (message.subtype === 'success') {
        resultText = (message as SDKResultSuccess).result;
      } else {
        const errorResult = message as SDKResultError;
        throw new Error(`NLP summarization SDK error: ${errorResult.errors?.join(', ') ?? errorResult.subtype}`);
      }
    }
  }

  return resultText;
}
