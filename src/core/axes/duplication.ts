import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery } from '../axis-evaluator.js';
import { resolveAxisModel } from '../axis-evaluator.js';
import { contextLogger } from '../../utils/log-context.js';
import duplicationSystemPrompt from './prompts/duplication.system.md';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (duplication axis only)
// ---------------------------------------------------------------------------

const DuplicateTargetResponseSchema = z.object({
  file: z.string(),
  symbol: z.string(),
  similarity: z.string(),
});

const DuplicationSymbolSchema = z.object({
  name: z.string(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  duplication: z.enum(['UNIQUE', 'DUPLICATE']),
  confidence: z.int().min(0).max(100),
  detail: z.string().min(10),
  duplicate_target: DuplicateTargetResponseSchema.nullable().optional(),
});

const DuplicationResponseSchema = z.object({
  symbols: z.array(DuplicationSymbolSchema),
});

type DuplicationResponse = z.infer<typeof DuplicationResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildDuplicationSystemPrompt(): string {
  return duplicationSystemPrompt.trimEnd();
}

export function buildDuplicationUserMessage(ctx: AxisContext): string {
  const parts: string[] = [];

  parts.push(`## File: \`${ctx.task.file}\``);
  parts.push('');
  parts.push('```typescript');
  parts.push(ctx.fileContent);
  parts.push('```');
  parts.push('');

  parts.push('## Symbols to evaluate');
  parts.push('');
  for (const s of ctx.task.symbols) {
    parts.push(`- ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (L${s.line_start}–L${s.line_end})`);
  }
  parts.push('');

  if (ctx.preResolvedRag && ctx.preResolvedRag.length > 0) {
    parts.push('## RAG — Semantic Duplication');
    parts.push('');
    for (const entry of ctx.preResolvedRag) {
      parts.push(`### ${entry.symbolName} (L${entry.lineStart}–L${entry.lineEnd})`);
      if (entry.results === null) {
        parts.push('Function not indexed — cannot check for duplication. Mark UNIQUE.');
      } else if (entry.results.length === 0) {
        parts.push('No similar functions found. Mark UNIQUE.');
      } else {
        parts.push('Similar functions found:');
        for (const r of entry.results) {
          parts.push(`- **${r.card.name}** in \`${r.card.filePath}\` (score: ${r.score.toFixed(3)})`);
          parts.push(`  Signature: ${r.card.signature}`);
          parts.push(`  Complexity: ${r.card.complexityScore}/5`);
          if (r.card.calledInternals.length > 0) {
            parts.push(`  Calls: ${r.card.calledInternals.join(', ')}`);
          }
          // Include candidate source code (up to ~50 lines)
          const candidateSource = readCandidateSource(ctx.projectRoot, r.card.filePath, r.card.name);
          if (candidateSource) {
            parts.push('  Source:');
            parts.push('  ```typescript');
            parts.push(`  ${candidateSource.split('\n').join('\n  ')}`);
            parts.push('  ```');
          }
        }
      }
      parts.push('');
    }
  } else {
    parts.push('## RAG — Semantic Duplication');
    parts.push('');
    parts.push('No RAG data available. Mark all symbols as UNIQUE (confidence: 90).');
    parts.push('');
  }

  parts.push('Evaluate the duplication of each symbol and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_CANDIDATE_LINES = 50;

/**
 * Read candidate function source from disk for code-to-code comparison.
 * Returns null if the file is missing or the function can't be located.
 */
function readCandidateSource(projectRoot: string, filePath: string, functionName: string): string | null {
  try {
    const absPath = resolve(projectRoot, filePath);
    const source = readFileSync(absPath, 'utf-8');
    const lines = source.split('\n');

    // Find the function by name (simple heuristic: first line containing the function name + opening)
    const startIdx = lines.findIndex((line) =>
      line.includes(functionName) && (line.includes('function') || line.includes('=>') || line.includes('('))
    );
    if (startIdx === -1) return null;

    // Extract up to MAX_CANDIDATE_LINES lines
    const snippet = lines.slice(startIdx, startIdx + MAX_CANDIDATE_LINES);
    return snippet.join('\n');
  } catch {
    contextLogger().warn({ filePath, functionName }, 'candidate source file not found on disk');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

export class DuplicationEvaluator implements AxisEvaluator {
  readonly id = 'duplication' as const;
  readonly defaultModel = 'haiku' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildDuplicationSystemPrompt();
    const userMessage = buildDuplicationUserMessage(ctx);

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<DuplicationResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
      },
      DuplicationResponseSchema,
    );

    const symbols: AxisSymbolResult[] = data.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.duplication,
      confidence: s.confidence,
      detail: s.detail,
      duplicate_target: s.duplicate_target ?? undefined,
    }));

    return {
      axisId: 'duplication',
      symbols,
      actions: [],
      costUsd,
      durationMs,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      transcript,
    };
  }
}
