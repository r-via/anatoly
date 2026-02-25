import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery } from '../axis-evaluator.js';
import { resolveAxisModel } from '../axis-evaluator.js';

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
  return `You are Anatoly, a rigorous TypeScript code auditor focused EXCLUSIVELY on the **duplication** axis.

## Your ONLY task

Evaluate whether each symbol is UNIQUE or a DUPLICATE of another function in the codebase.

## Rules

1. Use the RAG Similarity results provided. This data comes from a semantic vector search.
2. Score >= 0.85 with matching logic/behavior = DUPLICATE (confidence: 90+).
3. Score >= 0.75 but different logic = UNIQUE (note similarity in detail).
4. No similar functions found = UNIQUE (confidence: 95).
5. If DUPLICATE, you MUST provide duplicate_target with file, symbol, and similarity description.
6. Do NOT evaluate other axes — only duplication.

## Output format

Output ONLY a JSON object (no markdown fences, no explanation):

\`\`\`json
{
  "symbols": [
    {
      "name": "symbolName",
      "line_start": 1,
      "line_end": 10,
      "duplication": "UNIQUE | DUPLICATE",
      "confidence": 95,
      "detail": "Explanation (min 10 chars)",
      "duplicate_target": null
    }
  ]
}
\`\`\`

For DUPLICATE symbols, duplicate_target should be:
\`\`\`json
{
  "file": "src/other/file.ts",
  "symbol": "otherFunction",
  "similarity": "95% identical logic — both compute X from Y"
}
\`\`\``;
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
          parts.push(`  Summary: ${r.card.summary}`);
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
// Evaluator class
// ---------------------------------------------------------------------------

export class DuplicationEvaluator implements AxisEvaluator {
  readonly id = 'duplication' as const;
  readonly defaultModel = 'haiku' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildDuplicationSystemPrompt();
    const userMessage = buildDuplicationUserMessage(ctx);

    const { data, costUsd, durationMs, transcript } = await runSingleTurnQuery<DuplicationResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: '.',
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
      transcript,
    };
  }
}
