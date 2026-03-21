// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel } from '../axis-evaluator.js';
import documentationSystemPrompt from './prompts/documentation.system.md';
import { formatReclassificationsForAxis } from '../correction-memory.js';

// ---------------------------------------------------------------------------
// Zod schemas for LLM response (documentation axis)
// ---------------------------------------------------------------------------

const DocumentationSymbolSchema = z.object({
  name: z.string(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  documentation: z.enum(['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED']),
  confidence: z.int().min(0).max(100),
  detail: z.string().min(10),
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

const DocumentationResponseSchema = z.object({
  symbols: z.array(DocumentationSymbolSchema),
  docs_coverage: DocsCoverageSchema.optional(),
});

type DocumentationResponse = z.infer<typeof DocumentationResponseSchema>;

export type DocsCoverage = z.infer<typeof DocsCoverageSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildDocumentationSystemPrompt(): string {
  return documentationSystemPrompt.trimEnd();
}

export function buildDocumentationUserMessage(ctx: AxisContext): string {
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
    parts.push('No /docs/ directory found — evaluate JSDoc only, skip concept coverage.');
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

export class DocumentationEvaluator implements AxisEvaluator {
  readonly id = 'documentation' as const;
  readonly defaultModel = 'haiku' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildDocumentationSystemPrompt();
    let userMessage = buildDocumentationUserMessage(ctx);

    const memorySection = formatReclassificationsForAxis(ctx.projectRoot, 'documentation');
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
