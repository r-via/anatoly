import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel } from '../axis-evaluator.js';

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

const RULES_TABLE = `| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | Strict mode (tsconfig strict: true) | HAUTE | -1 pt |
| 2 | No \`any\` (explicit or implicit) | CRITIQUE | -3 pts |
| 3 | Discriminated unions (prefer tagged unions over type assertions) | MOYENNE | -0.5 pt |
| 4 | Utility types (Pick, Omit, Partial, Required, Record) | MOYENNE | -0.5 pt |
| 5 | Immutability (readonly, as const where appropriate) | MOYENNE | -0.5 pt |
| 6 | Interface vs Type (consistent convention within project) | MOYENNE | -0.5 pt |
| 7 | File size (< 300 lines preferred) | HAUTE | -1 pt |
| 8 | ESLint compliance (no obvious lint violations) | HAUTE | -1 pt |
| 9 | JSDoc on public exports (except test files) | MOYENNE | -0.5 pt |
| 10 | Modern 2026 practices (no deprecated APIs, modern syntax) | MOYENNE | -0.5 pt |
| 11 | Import organization (grouped, no circular, no side-effect imports) | MOYENNE | -0.5 pt |
| 12 | Async/Promises/Error handling (no unhandled rejections, proper try-catch) | HAUTE | -1 pt |
| 13 | Security (no hardcoded secrets, no eval, no command injection) | CRITIQUE | -4 pts |
| 14 | Performance (no obvious N+1, unnecessary re-renders, sync I/O in async) | MOYENNE | -0.5 pt |
| 15 | Testability (dependency injection, low coupling, pure functions) | MOYENNE | -0.5 pt |
| 16 | TypeScript 5.5+ features (satisfies, const type params, using) | MOYENNE | -0.5 pt |
| 17 | Context-adapted rules (React/API/Utility-specific best practices) | MOYENNE | -0.5 pt |`;

export function buildBestPracticesSystemPrompt(): string {
  return `You are Anatoly, a rigorous TypeScript code auditor focused EXCLUSIVELY on **best practices** evaluation.

## Your ONLY task

Evaluate the file against 17 TypeGuard v2 rules. Score the file from 0 to 10 (10 = perfect).

## Scoring

Start from 10.0 and subtract penalties per rule violation:

${RULES_TABLE}

## Rules for evaluation

1. Evaluate ALL 17 rules for EVERY file. Output all 17 rules in the result.
2. PASS = rule fully satisfied. WARN = minor issues. FAIL = clear violation.
3. Adjust evaluation based on file context (see context hint below).
4. For test files: rules 9 (JSDoc) and 15 (testability) are always PASS.
5. For config files: rules 3 (unions), 4 (utility types), 5 (immutability) are evaluated leniently.
6. Score cannot go below 0.
7. Include concrete suggestions with before/after code snippets when relevant.
8. Do NOT evaluate other axes — only best practices.

## Output format

Output ONLY a raw JSON object (no markdown fences, no explanation):

{
  "score": 8.5,
  "rules": [
    {
      "rule_id": 1,
      "rule_name": "Strict mode",
      "status": "PASS | WARN | FAIL",
      "severity": "CRITIQUE | HAUTE | MOYENNE",
      "detail": "Explanation (optional)",
      "lines": "L10-L20 (optional)"
    }
  ],
  "suggestions": [
    {
      "description": "Use readonly for immutable config",
      "before": "const config: Config = { ... }",
      "after": "const config: Readonly<Config> = { ... }"
    }
  ]
}`;
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
