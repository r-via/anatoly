// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import picomatch from 'picomatch';
import type { AxisContext, AxisResult, AxisEvaluator } from '../contract.js';
import type { Config } from '../../../schemas/config.js';
import { runSingleTurnQuery, resolveAxisModel, getCodeFenceTag, getLanguageLines } from '../evaluator.js';
import { resolveSystemPrompt } from '../../platform/index.js';
import { formatReclassificationsForAxis } from '../../platform/index.js';
import { DocDivergenceSchema } from '../../../schemas/review.js';
import { renderInternalDocsContext } from './internal-docs-context.js';
import { renderReferenceDocsContext } from './reference-docs-context.js';
import { renderConsumerContext } from './consumer-context.js';
import { renderImportUsageContext } from './import-usage-context.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (best_practices axis — file-level, not per-symbol)
// ---------------------------------------------------------------------------

/** Zod schema for a single best-practices rule evaluation result. The `rule_id` is bounded 1–17 matching the fixed rule set. */
const BestPracticesRuleResponseSchema = z.object({
  rule_id: z.int().min(1).max(17),
  rule_name: z.string(),
  status: z.enum(['PASS', 'WARN', 'FAIL']),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM']),
  detail: z.string().optional(),
  lines: z.string().optional(),
});

/** Zod schema for a single code-improvement suggestion with optional before/after snippets. */
const BestPracticesSuggestionSchema = z.object({
  description: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
});

/** Zod schema for the structured LLM response from the best-practices axis evaluation. */
export const BestPracticesResponseSchema = z.object({
  score: z.number().min(0).max(10),
  rules: z.array(BestPracticesRuleResponseSchema),
  suggestions: z.array(BestPracticesSuggestionSchema).default([]),
  /** Doc divergence findings when reference docs contradict code (Story 54.9, FR15). */
  doc_divergences: z.array(DocDivergenceSchema).optional(),
});

type BestPracticesResponse = z.infer<typeof BestPracticesResponseSchema>;

// ---------------------------------------------------------------------------
// File context detection
// ---------------------------------------------------------------------------

export type FileContext = 'react-component' | 'api-handler' | 'utility' | 'test' | 'config' | 'general';

/** Infers a coarse {@link FileContext} category from the file path and content for best-practices scoring. */
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

  // Use path-segment matching to avoid false positives (e.g. "deliberation", "calibration")
  const segments = lower.split('/');
  if (
    segments.some((seg) => seg.includes('util') || seg.includes('helper') || seg === 'lib' || seg.startsWith('lib.'))
  ) {
    return 'utility';
  }

  return 'general';
}

/**
 * Whether `filePath` is vendored / third-party code (matched against the
 * configured `scan.vendored` globs, e.g. `**\/components/ui/**` for shadcn).
 * Vendored files are still audited, but best-practices suppresses stylistic
 * suggestions on them (diverging from upstream complicates resync). Empty /
 * unset config → never vendored.
 */
export function isVendoredFile(filePath: string, config: Config): boolean {
  const globs = config.scan?.vendored ?? [];
  if (globs.length === 0) return false;
  return picomatch(globs)(filePath);
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/** Builds the system prompt for the best-practices axis LLM call. */
export function buildBestPracticesSystemPrompt(): string {
  return resolveSystemPrompt('best_practices');
}

/** Assembles the user message for the best-practices axis, including file content, stats, and project context. */
export function buildBestPracticesUserMessage(ctx: AxisContext): string {
  const parts: string[] = [];

  const fileCtx = detectFileContext(ctx.task.file, ctx.fileContent);

  parts.push(`## File: \`${ctx.task.file}\``);
  parts.push(...getLanguageLines(ctx.task));
  parts.push(`## Context: ${fileCtx}`);
  if (isVendoredFile(ctx.task.file, ctx.config)) {
    parts.push('');
    parts.push('## Vendored / third-party file (kept close to upstream)');
    parts.push(
      'This file matches a configured vendored path. Flag ONLY real defects: bugs, security issues, unhandled errors, and genuinely dead code (e.g. unused imports). Do NOT report stylistic preferences — `readonly`, `satisfies`/`as const`, JSDoc, interface-vs-type, import ordering, naming, or micro-optimisations — because diverging from upstream complicates resync. For those stylistic rules, return PASS unless there is a real, observed defect.',
    );
  }
  parts.push('');
  parts.push(`\`\`\`${getCodeFenceTag(ctx.task)}`);
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

  const importUsageSection = renderImportUsageContext(ctx);
  if (importUsageSection) parts.push(importUsageSection);

  const referenceDocsSection = renderReferenceDocsContext(ctx.referenceDocs, ctx.arbitratedFragments);
  if (referenceDocsSection) {
    parts.push(referenceDocsSection);
  }

  const internalDocsSection = renderInternalDocsContext(ctx.relevantDocs, ctx.config);
  if (internalDocsSection) {
    parts.push(internalDocsSection);
  }

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

  const consumerSection = renderConsumerContext(ctx);
  if (consumerSection) parts.push(consumerSection);

  parts.push('Evaluate all 17 rules and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

/** Evaluator that scores a file against the 17 best-practices rules via an LLM call. */
export class BestPracticesEvaluator implements AxisEvaluator {
  readonly id = 'best_practices' as const;
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = resolveSystemPrompt('best_practices', ctx.task.language, ctx.task.framework);
    let userMessage = buildBestPracticesUserMessage(ctx);

    const fileSymbols = new Set(ctx.task.symbols.map(s => s.name));
    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'best_practices', fileSymbols);
    if (memorySection) {
      userMessage += '\n' + memorySection;
    }

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<BestPracticesResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
        conversationDir: ctx.conversationDir,
        callId: ctx.callId,
        router: ctx.router,
        userInstructions: ctx.userInstructions?.forAxis('best_practices'),
        composer: 'axes.best-practices',
        primitive: 'axes.best-practices',
        timeoutMs: ctx.config.runtime.timeout_per_call * 1000,
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
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      transcript,
      _bestPractices: data,
      ...(data.doc_divergences ? { doc_divergences: data.doc_divergences } : {}),
    } as AxisResult & { _bestPractices: BestPracticesResponse };
  }
}
