// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel, getCodeFenceTag, getLanguageLines } from '../axis-evaluator.js';
import { resolveSystemPrompt } from '../prompt-resolver.js';
import { formatReclassificationsForAxis } from '../correction-memory.js';
import { BaseSymbolSchema } from '../../schemas/base-symbol.js';

// ---------------------------------------------------------------------------
// Zod schemas for LLM response (documentation axis)
// ---------------------------------------------------------------------------

const DocumentationSymbolSchema = BaseSymbolSchema.extend({
  documentation: z.enum(['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED']),
});

const DocsCoverageConceptSchema = z.object({
  name: z.string(),
  status: z.enum(['COVERED', 'PARTIAL', 'MISSING', 'OUTDATED']),
  doc_path: z.string().nullable(),
  detail: z.string().min(10),
});

const DocsCoverageSchema = z.object({
  concepts: z.array(DocsCoverageConceptSchema),
  score_pct: z.number().min(0).max(100),
});

/** Zod schema validating the LLM response for the documentation axis. */
export const DocumentationResponseSchema = z.object({
  symbols: z.array(DocumentationSymbolSchema),
  docs_coverage: DocsCoverageSchema.optional(),
});

type DocumentationResponse = z.infer<typeof DocumentationResponseSchema>;

export type DocsCoverage = z.infer<typeof DocsCoverageSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildDocumentationSystemPrompt(): string {
  return resolveSystemPrompt('documentation');
}

/**
 * Builds the user-message prompt for the documentation axis LLM call.
 *
 * Assembles file content, symbol list, project documentation pages (scored),
 * internal reference docs (context-only, not scored), docs-tree listing, and a
 * no-docs fallback into a Markdown prompt.
 *
 * @param ctx Axis evaluation context with file content, symbols, docs tree, and relevant docs.
 * @returns The assembled prompt string.
 */
export function buildDocumentationUserMessage(ctx: AxisContext): string {
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

  // Separate project docs (scoring) from internal docs (context only) — Story 29.21
  const projectDocs = ctx.relevantDocs?.filter(d => d.source !== 'internal') ?? [];
  const internalDocs = ctx.relevantDocs?.filter(d => d.source === 'internal') ?? [];

  if (ctx.docsTree || projectDocs.length > 0) {
    if (ctx.docsTree) {
      parts.push('## Documentation Directory (docs/)');
      parts.push('');
      parts.push('```');
      parts.push(ctx.docsTree);
      parts.push('```');
      parts.push('');
    }

    if (projectDocs.length > 0) {
      parts.push('## Relevant Documentation Pages (from docs/ — USE FOR SCORING)');
      parts.push('');
      for (const doc of projectDocs) {
        parts.push(`### \`${doc.path}\``);
        parts.push('');
        parts.push(doc.content);
        parts.push('');
      }
    }
  } else {
    parts.push('## Documentation Directory');
    parts.push('');
    parts.push('No /docs/ directory found — evaluate inline documentation only, skip concept coverage.');
    parts.push('');
  }

  // Internal docs provide context but do NOT count for scoring
  if (internalDocs.length > 0) {
    parts.push('## Internal Reference Documentation (from .anatoly/docs/ — DO NOT use for scoring)');
    parts.push('');
    parts.push('> These pages are auto-generated internal references. They provide context but should NOT influence DOCUMENTED/COVERED status.');
    parts.push('');
    for (const doc of internalDocs) {
      parts.push(`### \`${doc.path}\``);
      parts.push('');
      parts.push(doc.content);
      parts.push('');
    }
  }

  parts.push('Evaluate documentation for each symbol and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

/**
 * Axis evaluator for documentation quality. Performs a semaphore-guarded LLM
 * query to assess inline and project-level documentation per symbol, injecting
 * correction-memory reclassifications when available. JSON files are
 * short-circuited to all-DOCUMENTED results. Defaults to `sonnet` model.
 */
export class DocumentationEvaluator implements AxisEvaluator {
  readonly id = 'documentation' as const;
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    // AC 31.17.9: JSON files have no documentation convention — skip with all DOCUMENTED
    if (ctx.task.language === 'json') {
      const symbols: AxisSymbolResult[] = ctx.task.symbols.map((s) => ({
        name: s.name,
        line_start: s.line_start,
        line_end: s.line_end,
        value: 'DOCUMENTED' as const,
        confidence: 100,
        detail: 'JSON keys do not require documentation comments.',
      }));
      return { axisId: 'documentation', symbols, actions: [], costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, transcript: '' };
    }

    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = resolveSystemPrompt('documentation', ctx.task.language, ctx.task.framework);
    let userMessage = buildDocumentationUserMessage(ctx);

    const fileSymbols = new Set(ctx.task.symbols.map(s => s.name));
    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'documentation', fileSymbols);
    if (memorySection) {
      userMessage += '\n' + memorySection;
    }

    const { data, costUsd, durationMs, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, transcript } = await runSingleTurnQuery<DocumentationResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
        conversationDir: ctx.conversationDir,
        conversationPrefix: ctx.conversationDir ? `${ctx.conversationFileSlug}__documentation` : undefined,
        semaphore: ctx.semaphore,
        geminiSemaphore: ctx.geminiSemaphore,
        circuitBreaker: ctx.circuitBreaker,
        router: ctx.router,
        userInstructions: ctx.userInstructions?.forAxis('documentation'),
      },
      DocumentationResponseSchema,
    );

    const symbols: AxisSymbolResult[] = data.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.documentation,
      confidence: s.confidence,
      detail: s.detail,
    }));

    return {
      axisId: 'documentation',
      symbols,
      actions: [],
      costUsd,
      durationMs,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      transcript,
      _docsCoverage: data.docs_coverage,
    } as AxisResult & { _docsCoverage?: DocsCoverage };
  }
}
