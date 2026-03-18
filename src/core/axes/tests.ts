import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel } from '../axis-evaluator.js';
import testsSystemPrompt from './prompts/tests.system.md';

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
  return testsSystemPrompt.trimEnd();
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

  // Inject test file content if available
  if (ctx.testFileContent) {
    const testFileName = ctx.task.file.replace(/\.ts$/, '.test.ts');
    parts.push(`## Test File: \`${testFileName}\``);
    parts.push('');
    parts.push('```typescript');
    parts.push(ctx.testFileContent);
    parts.push('```');
    parts.push('');
  } else {
    parts.push('## Test File');
    parts.push('');
    parts.push('No test file found for this source file.');
    parts.push('');
  }

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

  // Inject callers from usage graph for business context
  if (ctx.usageGraph) {
    const callers: string[] = [];
    for (const s of ctx.task.symbols) {
      const usage = ctx.usageGraph.usages.get(`${ctx.task.file}:${s.name}`);
      if (usage && usage.importedBy.length > 0) {
        callers.push(`- \`${s.name}\` is imported by: ${usage.importedBy.map((f) => `\`${f}\``).join(', ')}`);
      }
    }
    if (callers.length > 0) {
      parts.push('## Symbol Usage (callers)');
      parts.push('');
      for (const c of callers) parts.push(c);
      parts.push('');
    }
  }

  // Inject project tree for architectural context
  if (ctx.projectTree) {
    parts.push('## Project Structure');
    parts.push('');
    parts.push('```');
    parts.push(ctx.projectTree);
    parts.push('```');
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

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<TestsResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
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
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      transcript,
    };
  }
}
