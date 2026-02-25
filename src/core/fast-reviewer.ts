import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultSuccess, SDKAssistantMessage, SDKUserMessage, SDKSystemMessage, SDKResultError } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../schemas/config.js';
import type { Task } from '../schemas/task.js';
import type { ReviewFile } from '../schemas/review.js';
import type { PromptOptions, PreResolvedRag } from '../utils/prompt-builder.js';
import { getSymbolUsage } from './usage-graph.js';
import { toOutputName } from '../utils/cache.js';
import { AnatolyError, ERROR_CODES } from '../utils/errors.js';
import { extractJson } from '../utils/extract-json.js';
import { ReviewFileSchema } from '../schemas/review.js';
import { buildFunctionId } from '../rag/indexer.js';

export interface FastReviewResult {
  review: ReviewFile;
  transcript: string;
  costUsd: number;
  retries: number;
  promoted: false;
}

export interface FastReviewPromoted {
  promoted: true;
  reason: string;
}

export type FastReviewOutcome = FastReviewResult | FastReviewPromoted;

/**
 * Build the system prompt for fast reviews (single-turn, no tools).
 */
export function buildFastSystemPrompt(task: Task): string {
  return `You are Anatoly, a rigorous TypeScript code auditor.
You audit code with high confidence using ONLY the context provided below.
You do NOT have access to any tools — all information is pre-computed and included.

## Rules

1. Evaluate ALL symbols listed below — do not skip any.
2. For **utility**: use the Pre-computed Import Analysis below. 0 importers on an exported symbol = DEAD (confidence: 95). Non-exported = check local usage in the file content.
3. For **duplication**: use the RAG Similarity results below. Score >= 0.85 = DUPLICATE. No results = UNIQUE.
4. **confidence: 100** = certain from the provided data. **confidence < 70** = uncertain.
5. All context is provided. Output ONLY the JSON.

## Output format

Output a single JSON object (no markdown fences, no explanation) conforming to:

\`\`\`json
{
  "version": 1,
  "file": "${task.file}",
  "is_generated": false,
  "verdict": "CLEAN | NEEDS_REFACTOR | CRITICAL",
  "symbols": [
    {
      "name": "symbolName",
      "kind": "function | class | method | type | constant | variable | enum | hook",
      "exported": true,
      "line_start": 1,
      "line_end": 10,
      "correction": "OK | NEEDS_FIX | ERROR",
      "overengineering": "LEAN | OVER | ACCEPTABLE",
      "utility": "USED | DEAD | LOW_VALUE",
      "duplication": "UNIQUE | DUPLICATE",
      "tests": "GOOD | WEAK | NONE",
      "confidence": 85,
      "detail": "Explanation of findings (min 10 chars)"
    }
  ],
  "actions": [],
  "file_level": {
    "unused_imports": [],
    "circular_dependencies": [],
    "general_notes": ""
  }
}
\`\`\`

## Guardrails

- Files under 20 lines: do NOT mark as overengineering: "OVER".
- tests: "NONE" alone does NOT justify verdict NEEDS_REFACTOR.
- verdict CRITICAL = any symbol has correction: "ERROR".
- verdict NEEDS_REFACTOR = any symbol has correction/utility/duplication/overengineering issues (tests: "NONE" alone is NOT an issue).
- verdict CLEAN = all symbols healthy.
- Output ONLY the JSON object. No preamble, no markdown fences.`;
}

/**
 * Build the user message for a fast review with all context inline.
 */
export function buildFastUserMessage(
  task: Task,
  fileContent: string,
  options: PromptOptions = {},
): string {
  const parts: string[] = [];

  parts.push(`## File: \`${task.file}\``);
  parts.push('');
  parts.push('```typescript');
  parts.push(fileContent);
  parts.push('```');
  parts.push('');

  parts.push('## Symbols');
  parts.push('');
  if (task.symbols.length === 0) {
    parts.push('(no symbols detected)');
  } else {
    for (const s of task.symbols) {
      parts.push(`- ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (L${s.line_start}–L${s.line_end})`);
    }
  }
  parts.push('');

  if (task.coverage) {
    const cov = task.coverage;
    const pct = (covered: number, total: number) =>
      total > 0 ? ((covered / total) * 100).toFixed(1) : 'N/A';
    parts.push('## Coverage');
    parts.push('');
    parts.push(`- Statements: ${pct(cov.statements_covered, cov.statements_total)}% (${cov.statements_covered}/${cov.statements_total})`);
    parts.push(`- Branches: ${pct(cov.branches_covered, cov.branches_total)}% (${cov.branches_covered}/${cov.branches_total})`);
    parts.push(`- Functions: ${pct(cov.functions_covered, cov.functions_total)}% (${cov.functions_covered}/${cov.functions_total})`);
    parts.push(`- Lines: ${pct(cov.lines_covered, cov.lines_total)}% (${cov.lines_covered}/${cov.lines_total})`);
    parts.push('');
  }

  if (options.usageGraph && task.symbols.length > 0) {
    parts.push('## Pre-computed Import Analysis');
    parts.push('');
    for (const sym of task.symbols) {
      if (sym.exported) {
        const importers = getSymbolUsage(options.usageGraph, sym.name, task.file);
        if (importers.length === 0) {
          parts.push(`- ${sym.name} (exported): imported by 0 files — LIKELY DEAD`);
        } else {
          parts.push(`- ${sym.name} (exported): imported by ${importers.length} file${importers.length > 1 ? 's' : ''}: ${importers.join(', ')}`);
        }
      } else {
        parts.push(`- ${sym.name} (not exported): internal only`);
      }
    }
    parts.push('');
  }

  if (options.ragEnabled && options.preResolvedRag && options.preResolvedRag.length > 0) {
    parts.push('## RAG — Semantic Duplication');
    parts.push('');
    for (const entry of options.preResolvedRag) {
      parts.push(`### ${entry.symbolName} (L${entry.lineStart}–L${entry.lineEnd})`);
      if (entry.results === null) {
        parts.push('Function not indexed — cannot check for duplication.');
      } else if (entry.results.length === 0) {
        parts.push('No similar functions found.');
      } else {
        parts.push('Similar functions found:');
        for (const r of entry.results) {
          parts.push(`- **${r.card.name}** in \`${r.card.filePath}\` (score: ${r.score.toFixed(3)})`);
          parts.push(`  Summary: ${r.card.summary}`);
        }
      }
      parts.push('');
    }
  }

  parts.push('Review this file and output the JSON review object.');

  return parts.join('\n');
}

/**
 * Pre-resolve RAG similarity results for function symbols.
 */
async function preResolveFastRag(task: Task, options: PromptOptions): Promise<PromptOptions> {
  if (!options.ragEnabled || !options.vectorStore) return options;

  const functionSymbols = task.symbols.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook',
  );

  const preResolved: PreResolvedRag = [];
  for (const symbol of functionSymbols) {
    const functionId = buildFunctionId(task.file, symbol.line_start, symbol.line_end);
    try {
      const results = await options.vectorStore.searchById(functionId);
      preResolved.push({ symbolName: symbol.name, lineStart: symbol.line_start, lineEnd: symbol.line_end, results });
    } catch {
      preResolved.push({ symbolName: symbol.name, lineStart: symbol.line_start, lineEnd: symbol.line_end, results: null });
    }
  }

  return { ...options, preResolvedRag: preResolved };
}

/**
 * Try to parse and validate a JSON response against ReviewFileSchema.
 */
function tryParseFastReview(
  responseText: string,
): { success: true; data: ReviewFile } | { success: false; error: string } {
  const jsonStr = extractJson(responseText);
  if (!jsonStr) return { success: false, error: 'No valid JSON found in response' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { success: false, error: 'Invalid JSON syntax' };
  }

  const result = ReviewFileSchema.safeParse(parsed);
  if (!result.success) {
    const formatted = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    return { success: false, error: formatted };
  }

  return { success: true, data: result.data };
}

/**
 * Run a single fast query (maxTurns:1, no tools).
 */
async function runFastQuery(params: {
  prompt: string;
  systemPrompt?: string;
  model: string;
  projectRoot: string;
  abortController: AbortController;
  appendTranscript: (line: string) => void;
  resumeSessionId?: string;
}): Promise<{ resultText: string; costUsd: number; sessionId: string }> {
  const { prompt, systemPrompt, model, projectRoot, abortController, appendTranscript, resumeSessionId } = params;

  const q = query({
    prompt,
    options: {
      ...(systemPrompt ? { systemPrompt } : {}),
      model,
      cwd: projectRoot,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController,
      maxTurns: 1,
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
  });

  let resultText = '';
  let costUsd = 0;
  let sessionId = '';

  for await (const message of q) {
    appendTranscript(formatFastMessage(message));
    if ('session_id' in message) sessionId = message.session_id as string;

    if (message.type === 'result') {
      if (message.subtype === 'success') {
        const successMsg = message as SDKResultSuccess;
        resultText = successMsg.result;
        costUsd = successMsg.total_cost_usd;
        sessionId = successMsg.session_id;
      } else {
        const errorMsg = message as { errors: string[] };
        throw new AnatolyError(
          `Agent error: ${errorMsg.errors?.join(', ') ?? 'unknown'}`,
          ERROR_CODES.LLM_API_ERROR,
          true,
        );
      }
    }
  }

  return { resultText, costUsd, sessionId };
}

/**
 * Perform a fast single-turn review (no tools) for simple files.
 *
 * Flow:
 * 1. First query (maxTurns:1) → validate
 * 2. If invalid → retry with Zod feedback (maxTurns:1, resume)
 * 3. If still invalid → return promoted:true (caller should use deep review)
 */
export async function fastReviewFile(
  projectRoot: string,
  task: Task,
  config: Config,
  promptOptions: PromptOptions = {},
  externalAbort?: AbortController,
  runDir?: string,
): Promise<FastReviewOutcome> {
  const absPath = resolve(projectRoot, task.file);
  let fileContent: string;
  try {
    fileContent = readFileSync(absPath, 'utf-8');
  } catch {
    return { promoted: true, reason: 'file unreadable' };
  }

  const resolvedOptions = await preResolveFastRag(task, promptOptions);
  const model = config.llm.fast_model ?? config.llm.model;
  const systemPrompt = buildFastSystemPrompt(task);
  const userMessage = buildFastUserMessage(task, fileContent, resolvedOptions);

  const logsDir = runDir ? join(runDir, 'logs') : join(projectRoot, '.anatoly', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const transcriptPath = join(logsDir, `${toOutputName(task.file)}.transcript.md`);
  const transcriptLines: string[] = [];
  const appendTranscript = (line: string): void => { transcriptLines.push(line); };

  transcriptLines.push(`# Transcript (fast): ${task.file}`);
  transcriptLines.push(`**Date:** ${new Date().toISOString()}`);
  transcriptLines.push(`**Model:** ${model}`);
  transcriptLines.push(`**Mode:** fast (single-turn, no tools)`);
  transcriptLines.push('');

  const abortController = new AbortController();
  const timeoutMs = config.llm.timeout_per_file * 1000;
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  const onExternalAbort = () => abortController.abort();
  if (externalAbort) {
    if (externalAbort.signal.aborted) {
      abortController.abort();
    } else {
      externalAbort.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    // Attempt 1: initial query
    const initial = await runFastQuery({
      prompt: userMessage,
      systemPrompt,
      model,
      projectRoot,
      abortController,
      appendTranscript,
    });

    const validation1 = tryParseFastReview(initial.resultText);
    if (validation1.success) {
      return {
        review: validation1.data,
        transcript: transcriptLines.join('\n'),
        costUsd: initial.costUsd,
        retries: 0,
        promoted: false,
      };
    }

    // Attempt 2: retry with Zod feedback
    transcriptLines.push(`\n## Retry: validation failed\n${validation1.error}\n`);

    const feedback = `Your JSON output failed validation:\n  ${validation1.error}\n\nFix these issues and output ONLY the corrected JSON object. No markdown fences, no explanation.`;
    const retry = await runFastQuery({
      prompt: feedback,
      model,
      projectRoot,
      abortController,
      appendTranscript,
      resumeSessionId: initial.sessionId,
    });

    const totalCost = initial.costUsd + retry.costUsd;
    const validation2 = tryParseFastReview(retry.resultText);
    if (validation2.success) {
      return {
        review: validation2.data,
        transcript: transcriptLines.join('\n'),
        costUsd: totalCost,
        retries: 1,
        promoted: false,
      };
    }

    // Both attempts failed — promote to deep
    transcriptLines.push(`\n## Promoted to deep: validation failed after 2 attempts\n${validation2.error}\n`);
    return { promoted: true, reason: 'Zod validation failed after 2 fast attempts' };
  } catch (error) {
    if (error instanceof AnatolyError) throw error;

    if (abortController.signal.aborted) {
      if (externalAbort?.signal.aborted) {
        throw new AnatolyError(`Fast review interrupted for ${task.file}`, ERROR_CODES.LLM_API_ERROR, true);
      }
      throw new AnatolyError(`Fast review timed out after ${config.llm.timeout_per_file}s for ${task.file}`, ERROR_CODES.LLM_TIMEOUT, true);
    }

    throw new AnatolyError(
      `Fast review error for ${task.file}: ${error instanceof Error ? error.message : String(error)}`,
      ERROR_CODES.LLM_API_ERROR,
      true,
    );
  } finally {
    clearTimeout(timeoutId);
    if (externalAbort) {
      externalAbort.signal.removeEventListener('abort', onExternalAbort);
    }
    if (transcriptLines.length > 0) {
      writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');
    }
  }
}

/**
 * Format an SDK message for the fast review transcript.
 */
function formatFastMessage(message: SDKMessage): string {
  switch (message.type) {
    case 'assistant': {
      const msg = message as SDKAssistantMessage;
      const content = msg.message.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as Array<Record<string, unknown>>)
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n')
          : '';
      return `## Assistant\n\n${text}\n`;
    }
    case 'user': {
      const msg = message as SDKUserMessage;
      const text = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content);
      return `## User\n\n${text}\n`;
    }
    case 'system': {
      const msg = message as SDKSystemMessage;
      if (msg.subtype === 'init') {
        return `## System (init)\n\n**Model:** ${msg.model}\n**Mode:** fast (no tools)\n`;
      }
      return `## System (${msg.subtype})\n`;
    }
    case 'result': {
      if (message.subtype === 'success') {
        const msg = message as SDKResultSuccess;
        return `## Result (success)\n\n**Cost:** $${msg.total_cost_usd.toFixed(4)} | **Duration:** ${(msg.duration_ms / 1000).toFixed(1)}s\n`;
      }
      const msg = message as SDKResultError;
      return `## Result (${msg.subtype})\n\n**Errors:** ${msg.errors?.join(', ') ?? 'unknown'}\n`;
    }
    default:
      return `## ${message.type}\n`;
  }
}
