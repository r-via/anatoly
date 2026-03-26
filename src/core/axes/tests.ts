// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel, getCodeFenceTag, getLanguageLines } from '../axis-evaluator.js';
import { getSymbolUsage } from '../usage-graph.js';
import { resolveSystemPrompt } from '../prompt-resolver.js';
import { formatReclassificationsForAxis } from '../correction-memory.js';
import { BaseSymbolSchema } from '../../schemas/base-symbol.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (tests axis only)
// ---------------------------------------------------------------------------

const TestsSymbolSchema = BaseSymbolSchema.extend({
  tests: z.enum(['GOOD', 'WEAK', 'NONE']),
});

/** Zod schema validating the LLM response for the tests axis. */
export const TestsResponseSchema = z.object({
  symbols: z.array(TestsSymbolSchema),
});

type TestsResponse = z.infer<typeof TestsResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/** Resolves the system prompt template for the tests axis. */
export function buildTestsSystemPrompt(): string {
  return resolveSystemPrompt('tests');
}

/**
 * Builds the user-message prompt for the tests axis LLM call.
 *
 * Assembles source code, test file content (truncated to 500 lines), coverage
 * table, usage-graph callers, and project structure into a Markdown prompt.
 *
 * @param ctx Axis evaluation context with file content, test content, coverage, and graph data.
 * @returns The assembled prompt string.
 */
export function buildTestsUserMessage(ctx: AxisContext): string {
  const parts: string[] = [];

  parts.push(`## File: \`${ctx.task.file}\``);
  parts.push(...getLanguageLines(ctx.task));
  parts.push('');
  parts.push(`\`\`\`${getCodeFenceTag(ctx.task)}`);
  parts.push(ctx.fileContent);
  parts.push('```');
  parts.push('');

  parts.push('## Symbols to evaluate');
  parts.push('');
  for (const s of ctx.task.symbols) {
    parts.push(`- ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (L${s.line_start}–L${s.line_end})`);
  }
  parts.push('');

  // Inject test file content if available (truncate to avoid blowing context)
  const MAX_TEST_LINES = 500;
  if (ctx.testFileContent) {
    const displayName = ctx.testFileName ?? ctx.task.file.replace(/(\.\w+)$/, '.test$1');
    const testLines = ctx.testFileContent.split('\n');
    const truncated = testLines.length > MAX_TEST_LINES;
    parts.push(`## Test File: \`${displayName}\``);
    parts.push('');
    parts.push(`\`\`\`${getCodeFenceTag(ctx.task)}`);
    parts.push(truncated ? testLines.slice(0, MAX_TEST_LINES).join('\n') : ctx.testFileContent);
    parts.push('```');
    if (truncated) {
      parts.push(`*(truncated — ${testLines.length} lines total, showing first ${MAX_TEST_LINES})*`);
    }
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
      const importers = getSymbolUsage(ctx.usageGraph, s.name, ctx.task.file);
      if (importers.length > 0) {
        callers.push(`- \`${s.name}\` is imported by: ${importers.map((f) => `\`${f}\``).join(', ')}`);
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

  // Inject transitive coverage hints for private symbols
  // When a private symbol's only callers are well-tested exported symbols,
  // it is likely tested transitively — hint this to the LLM.
  if (ctx.usageGraph) {
    const transitiveHints: string[] = [];
    for (const s of ctx.task.symbols) {
      if (s.exported) continue;
      const callers = getSymbolUsage(ctx.usageGraph, s.name, ctx.task.file);
      // intra-file callers: exported symbols in the same file that reference this private symbol
      const intraKey = `${s.name}::${ctx.task.file}`;
      const intraRefs = ctx.usageGraph.intraFileRefs?.get(intraKey);
      if (intraRefs && intraRefs.size > 0) {
        const exportedCallers = [...intraRefs].filter((ref) =>
          ctx.task.symbols.some((sym) => sym.name === ref && sym.exported),
        );
        if (exportedCallers.length > 0) {
          transitiveHints.push(
            `- \`${s.name}\` (private) is called by exported symbols: ${exportedCallers.map((c) => `\`${c}\``).join(', ')}. If those callers are well-tested, rate this symbol GOOD (transitive coverage).`,
          );
        }
      } else if (callers.length > 0) {
        transitiveHints.push(
          `- \`${s.name}\` (private) is imported by: ${callers.map((f) => `\`${f}\``).join(', ')}. Consider transitive coverage through its callers.`,
        );
      }
    }
    if (transitiveHints.length > 0) {
      parts.push('## Transitive Coverage Hints');
      parts.push('');
      parts.push('Private symbols tested through their callers should be rated based on caller test quality:');
      parts.push('- If ALL exported callers are GOOD → rate the private symbol GOOD');
      parts.push('- If callers are WEAK → rate WEAK');
      parts.push('- Only rate NONE if no caller exercises the symbol at all');
      parts.push('');
      for (const h of transitiveHints) parts.push(h);
      parts.push('');
    }
  }

  parts.push('Evaluate the test quality for each symbol and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

/**
 * Axis evaluator for test quality. Performs a semaphore-guarded LLM query
 * to assess test coverage/quality per symbol, injecting correction-memory
 * reclassifications when available. Defaults to `sonnet` model.
 */
export class TestsEvaluator implements AxisEvaluator {
  readonly id = 'tests' as const;
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildTestsSystemPrompt();
    let userMessage = buildTestsUserMessage(ctx);

    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'tests');
    if (memorySection) {
      userMessage += '\n' + memorySection;
    }

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<TestsResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
        conversationDir: ctx.conversationDir,
        conversationPrefix: ctx.conversationDir ? `${ctx.conversationFileSlug}__tests` : undefined,
        semaphore: ctx.semaphore,
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
