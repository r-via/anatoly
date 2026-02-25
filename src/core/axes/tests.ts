import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel } from '../axis-evaluator.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (tests axis only)
// ---------------------------------------------------------------------------

const TestsSymbolSchema = z.object({
  name: z.string(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  tests: z.enum(['GOOD', 'WEAK', 'NONE']),
  confidence: z.int().min(0).max(100),
  detail: z.string().min(10),
});

const TestsResponseSchema = z.object({
  symbols: z.array(TestsSymbolSchema),
});

type TestsResponse = z.infer<typeof TestsResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildTestsSystemPrompt(): string {
  return `You are Anatoly, a rigorous TypeScript code auditor focused EXCLUSIVELY on the **tests** axis.

## Your ONLY task

Evaluate the test coverage quality for each symbol: GOOD (well tested), WEAK (partially tested or fragile tests), or NONE (no tests found).

## Rules

1. GOOD = symbol has meaningful unit tests covering happy path and edge cases (confidence: 90+).
2. WEAK = symbol has tests but they are superficial, missing edge cases, or testing implementation details (confidence: 80+).
3. NONE = no test file or test cases found for this symbol (confidence: 95).
4. Use the coverage data provided (if available) as a signal, but do NOT rely on it exclusively — evaluate actual test quality.
5. Types, interfaces, and enums with no runtime behavior = GOOD by default (confidence: 95).
6. Do NOT evaluate other axes — only tests.

## Output format

Output ONLY a JSON object (no markdown fences, no explanation):

\`\`\`json
{
  "symbols": [
    {
      "name": "symbolName",
      "line_start": 1,
      "line_end": 10,
      "tests": "GOOD | WEAK | NONE",
      "confidence": 95,
      "detail": "Explanation (min 10 chars)"
    }
  ]
}
\`\`\``;
}

export function buildTestsUserMessage(ctx: AxisContext): string {
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

  if (ctx.task.coverage) {
    parts.push('## Coverage Data');
    parts.push('');
    const c = ctx.task.coverage;
    const pct = (covered: number, total: number) => total > 0 ? ((covered / total) * 100).toFixed(1) : '0.0';
    parts.push(`| Metric | Covered | Total | % |`);
    parts.push(`|--------|---------|-------|---|`);
    parts.push(`| Statements | ${c.statements_covered} | ${c.statements_total} | ${pct(c.statements_covered, c.statements_total)}% |`);
    parts.push(`| Branches | ${c.branches_covered} | ${c.branches_total} | ${pct(c.branches_covered, c.branches_total)}% |`);
    parts.push(`| Functions | ${c.functions_covered} | ${c.functions_total} | ${pct(c.functions_covered, c.functions_total)}% |`);
    parts.push(`| Lines | ${c.lines_covered} | ${c.lines_total} | ${pct(c.lines_covered, c.lines_total)}% |`);
    parts.push('');
  }

  parts.push('Evaluate the test quality for each symbol and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

export class TestsEvaluator implements AxisEvaluator {
  readonly id = 'tests' as const;
  readonly defaultModel = 'haiku' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildTestsSystemPrompt();
    const userMessage = buildTestsUserMessage(ctx);

    const { data, costUsd, durationMs, transcript } = await runSingleTurnQuery<TestsResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: '.',
        abortController,
      },
      TestsResponseSchema,
    );

    const symbols: AxisSymbolResult[] = data.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.tests,
      confidence: s.confidence,
      detail: s.detail,
    }));

    return {
      axisId: 'tests',
      symbols,
      actions: [],
      costUsd,
      durationMs,
      transcript,
    };
  }
}
