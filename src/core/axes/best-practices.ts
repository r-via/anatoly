import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel } from '../axis-evaluator.js';
import bestPracticesSystemPrompt from './prompts/best-practices.system.md';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (best_practices axis — file-level, not per-symbol)
// ---------------------------------------------------------------------------

const BestPracticesRuleResponseSchema = z.object({
  rule_id: z.int().min(1).max(17),
  rule_name: z.string(),
  status: z.enum(['PASS', 'WARN', 'FAIL']),
  severity: z.enum(['CRITIQUE', 'HAUTE', 'MOYENNE']),
  detail: z.string().optional(),
  lines: z.string().optional(),
});

const BestPracticesSuggestionSchema = z.object({
  description: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
});

const BestPracticesResponseSchema = z.object({
  score: z.number().min(0).max(10),
  rules: z.array(BestPracticesRuleResponseSchema),
  suggestions: z.array(BestPracticesSuggestionSchema).default([]),
});

type BestPracticesResponse = z.infer<typeof BestPracticesResponseSchema>;

// ---------------------------------------------------------------------------
// File context detection
// ---------------------------------------------------------------------------

export type FileContext = 'react-component' | 'api-handler' | 'utility' | 'test' | 'config' | 'general';

export function detectFileContext(filePath: string, fileContent: string): FileContext {
  const lower = filePath.toLowerCase();
  if (lower.includes('.test.') || lower.includes('.spec.')) return 'test';
  if (lower.includes('config') || lower.endsWith('.config.ts') || lower.endsWith('.config.js')) return 'config';

  if (
    /^import\b.*from\s+['"]react['"]/m.test(fileContent) ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.jsx')
  ) {
    return 'react-component';
  }

  if (
    lower.includes('route') ||
    lower.includes('controller') ||
    lower.includes('handler') ||
    /^import\b.*from\s+['"]express['"]/m.test(fileContent) ||
    /^import\b.*from\s+['"]fastify['"]/m.test(fileContent) ||
    /^import\b.*from\s+['"]hono['"]/m.test(fileContent)
  ) {
    return 'api-handler';
  }

  if (lower.includes('util') || lower.includes('helper') || lower.includes('lib')) {
    return 'utility';
  }

  return 'general';
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildBestPracticesSystemPrompt(): string {
  return bestPracticesSystemPrompt.trimEnd();
}

export function buildBestPracticesUserMessage(ctx: AxisContext): string {
  const parts: string[] = [];

  const fileCtx = detectFileContext(ctx.task.file, ctx.fileContent);

  parts.push(`## File: \`${ctx.task.file}\``);
  parts.push(`## Context: ${fileCtx}`);
  parts.push('');
  parts.push('```typescript');
  parts.push(ctx.fileContent);
  parts.push('```');
  parts.push('');

  parts.push(`## File stats`);
  const rawLines = ctx.fileContent.split('\n');
  const lineCount = rawLines[rawLines.length - 1] === '' ? rawLines.length - 1 : rawLines.length;
  parts.push(`- Lines: ${lineCount}`);
  parts.push(`- Symbols: ${ctx.task.symbols.length}`);
  parts.push(`- Exported symbols: ${ctx.task.symbols.filter((s) => s.exported).length}`);
  parts.push('');

  if (ctx.fileDeps && ctx.fileDeps.deps.length > 0) {
    parts.push('## Project Dependencies (imported in this file)');
    parts.push('');
    for (const dep of ctx.fileDeps.deps) {
      parts.push(`- ${dep.name}: ${dep.version}`);
    }
    if (ctx.fileDeps.nodeEngine) {
      parts.push(`- Node.js engine: ${ctx.fileDeps.nodeEngine}`);
    }
    parts.push('');
  }

  if (ctx.projectTree) {
    parts.push('## Project Structure');
    parts.push('');
    parts.push('```');
    parts.push(ctx.projectTree);
    parts.push('```');
    parts.push('');
    parts.push('Use the project structure above to evaluate rule 11 (import organization) and detect file placement inconsistencies. If the file is in an unexpected directory given the project conventions, flag it as WARN for the most relevant rule.');
    parts.push('');
  }

  parts.push('Evaluate all 17 rules and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

export class BestPracticesEvaluator implements AxisEvaluator {
  readonly id = 'best_practices' as const;
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildBestPracticesSystemPrompt();
    const userMessage = buildBestPracticesUserMessage(ctx);

    const { data, costUsd, durationMs, transcript } = await runSingleTurnQuery<BestPracticesResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: '.',
        abortController,
      },
      BestPracticesResponseSchema,
    );

    return {
      axisId: 'best_practices',
      symbols: [],
      fileLevel: {
        general_notes: `Best practices score: ${data.score}/10 (${data.rules.filter((r) => r.status === 'FAIL').length} FAIL, ${data.rules.filter((r) => r.status === 'WARN').length} WARN, ${data.rules.filter((r) => r.status === 'PASS').length} PASS)`,
      },
      actions: [],
      costUsd,
      durationMs,
      transcript,
      _bestPractices: data,
    } as AxisResult & { _bestPractices: BestPracticesResponse };
  }
}
