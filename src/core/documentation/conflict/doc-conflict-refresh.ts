// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getLogger } from '../../../utils/logger.js';
import { conversationsDir } from '../../../utils/run-layout.js';
import { isFatalAuthError, isCircuitOpenError } from '../../../utils/errors.js';
import { isRateLimitStandbyError } from '../../../utils/rate-limiter.js';
import { runSingleTurnQuery } from '../../evaluation/index.js';
import { type TransportRouter, type LlmResponse } from '../../transports/index.js';
import type { DocConflict, DocConflictVerdict } from '../../../schemas/doc-conflict.js';
import type { Config } from '../../../schemas/config.js';

const REFRESH_TIMEOUT_MS = 120_000;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;
const DEFAULT_BATCH_SIZE = 8;
const MAX_ANCHOR_FILE_BYTES = 1 * 1024 * 1024;
const MAX_CODE_EXCERPT_CHARS = 2000;

// ---------------------------------------------------------------------------
// LLM response schema
// ---------------------------------------------------------------------------

export const RefreshDecisionSchema = z.object({
  id: z.string(),
  decision: z.enum(['dismiss', 'doc-wins', 'code-wins', 'keep-pending']),
  confidence: z.number().min(0).max(1),
  note: z.string().max(500),
});

export const RefreshResponseSchema = z.object({
  decisions: z.array(RefreshDecisionSchema),
});

export type RefreshDecision = z.infer<typeof RefreshDecisionSchema>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RefreshOpts {
  projectRoot: string;
  config: Config;
  router?: TransportRouter;
  abortController?: AbortController;
  runDir?: string;
  confidenceThreshold?: number;
  batchSize?: number;
  onLlmResponse?: (r: LlmResponse) => void;
}

export interface RefreshSummary {
  inspected: number;
  autoResolved: { dismiss: number; docWins: number; codeWins: number };
  stillPending: number;
  belowConfidence: number;
  errors: number;
  cost?: {
    costUsd: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    calls: number;
  };
}

export interface RefreshResult {
  entries: DocConflict[];
  summary: RefreshSummary;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const REFRESH_SYSTEM_PROMPT = `You are auditing a doc-code conflict ledger. Each entry is a previously detected divergence between a piece of source code and a reference documentation excerpt. Your job is to decide, given the CURRENT state of code and docs shown in the user message, what verdict to apply to each entry.

For each entry, output exactly one decision with:
- id: the entry id as given
- decision: one of "dismiss" | "doc-wins" | "code-wins" | "keep-pending"
- confidence: a number in [0,1]
- note: short (<200 chars) human-readable justification

Verdict guide:

- "dismiss" — the entry is no longer (or never was) a real conflict. Use it when:
  * the anchor file no longer exists, or the cited code/symbol has been removed
  * the path contains "__gold-set__" (these are deliberate fixtures for the detector itself)
  * the cited divergence is not actually present when reading the CURRENT code vs the reference excerpt (false detection)
  * the entry duplicates another in the same batch (dismiss the older/weaker; keep the newest one)
  * the conflict has been resolved by changes on both sides

- "doc-wins" — the REFERENCE documentation is correct; code (or any derived internal doc) is the side that needs updating.

- "code-wins" — the CODE is correct; the reference documentation is the side that needs updating.

- "keep-pending" — genuine ambiguity, requires human/product context, or both sides have legitimate merit. Use this when you cannot honestly resolve from the evidence shown.

Confidence calibration: set confidence >= 0.85 ONLY when the evidence in front of you is unambiguous. Prefer lower confidence or "keep-pending" when the snippets do not fully ground the decision. A wrong high-confidence verdict is more costly than a kept-pending entry.

Output strict JSON matching the schema. No prose outside JSON.`;

// ---------------------------------------------------------------------------
// Per-entry context hydration
// ---------------------------------------------------------------------------

interface HydratedEntry {
  entry: DocConflict;
  currentCode: string;
}

function extractRange(content: string, lineRange?: [number, number]): string {
  if (!lineRange) return content.slice(0, MAX_CODE_EXCERPT_CHARS);
  const lines = content.split('\n');
  const start = Math.max(1, lineRange[0]);
  const end = Math.min(lines.length, lineRange[1]);
  return lines.slice(start - 1, end).join('\n').slice(0, MAX_CODE_EXCERPT_CHARS);
}

function hydrateEntry(projectRoot: string, entry: DocConflict): HydratedEntry {
  const log = getLogger();
  const fullPath = join(projectRoot, entry.anchor.file);
  if (!existsSync(fullPath)) {
    return { entry, currentCode: '<<FILE DELETED>>' };
  }
  try {
    const size = statSync(fullPath).size;
    if (size > MAX_ANCHOR_FILE_BYTES) {
      return { entry, currentCode: '<<FILE TOO LARGE TO INSPECT>>' };
    }
    const content = readFileSync(fullPath, 'utf-8');
    const range = entry.anchor.line_range as [number, number] | undefined;
    return { entry, currentCode: extractRange(content, range) };
  } catch (err) {
    log.warn({ file: entry.anchor.file, err: err instanceof Error ? err.message : String(err) },
      'doc-conflict-refresh: failed to read anchor file');
    return { entry, currentCode: '<<UNREADABLE>>' };
  }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export function buildRefreshUserMessage(batch: HydratedEntry[]): string {
  const lines: string[] = [];
  lines.push('Audit the following conflict entries. Return strict JSON: { "decisions": [...] } with one decision per entry. Match each decision.id to the entry id given.');
  lines.push('');
  for (const { entry, currentCode } of batch) {
    const sym = entry.anchor.symbol ? `::${entry.anchor.symbol}` : '';
    const lr = entry.anchor.line_range ? ` (L${entry.anchor.line_range[0]}-L${entry.anchor.line_range[1]})` : '';
    lines.push(`--- ENTRY id=${entry.id}`);
    lines.push(`Anchor: ${entry.anchor.file}${sym}${lr}`);
    lines.push(`Reference doc: ${entry.reference_excerpt.path}`);
    lines.push(`Reference excerpt (as originally detected):`);
    lines.push(`  "${entry.reference_excerpt.text.replace(/\n/g, ' ')}"`);
    lines.push(`Code summary (as originally detected):`);
    lines.push(`  "${entry.code_summary.replace(/\n/g, ' ')}"`);
    lines.push(`Status: ${entry.status}, presumption: ${entry.signals.presumption}`);
    lines.push(`CURRENT code at anchor:`);
    lines.push('```');
    lines.push(currentCode);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Verdict application
// ---------------------------------------------------------------------------

function decisionToVerdict(decision: RefreshDecision['decision']): DocConflictVerdict | null {
  if (decision === 'dismiss') return 'dismiss';
  if (decision === 'doc-wins') return 'doc-wins';
  if (decision === 'code-wins') return 'code-wins';
  return null;
}

function applyDecision(
  entry: DocConflict,
  decision: RefreshDecision,
  threshold: number,
): { entry: DocConflict; applied: boolean; belowConfidence: boolean } {
  const verdict = decisionToVerdict(decision.decision);
  if (!verdict) {
    return { entry, applied: false, belowConfidence: false };
  }
  if (decision.confidence < threshold) {
    return { entry, applied: false, belowConfidence: true };
  }
  const confPct = decision.confidence.toFixed(2);
  return {
    entry: {
      ...entry,
      verdict,
      status: 'auto-resolved',
      verdict_set_at: new Date().toISOString(),
      verdict_note: `[auto-llm conf=${confPct}] ${decision.note}`,
    },
    applied: true,
    belowConfidence: false,
  };
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function refreshPendingConflicts(
  entries: DocConflict[],
  opts: RefreshOpts,
): Promise<RefreshResult> {
  const log = getLogger();
  const { projectRoot, config, router, onLlmResponse } = opts;
  const threshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  const pendingIdx = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.verdict === 'pending');

  const summary: RefreshSummary = {
    inspected: pendingIdx.length,
    autoResolved: { dismiss: 0, docWins: 0, codeWins: 0 },
    stillPending: pendingIdx.length,
    belowConfidence: 0,
    errors: 0,
  };

  if (pendingIdx.length === 0) {
    return { entries, summary };
  }

  if (!router) {
    log.info('doc-conflict-refresh: no router — skipping LLM refresh');
    return { entries, summary };
  }

  const model = config.models.fast ?? config.models.quality;
  if (!model) {
    log.warn('doc-conflict-refresh: no fast/quality model configured — skipping');
    return { entries, summary };
  }

  const hydrated = pendingIdx.map(({ e, i }) => ({ idx: i, ...hydrateEntry(projectRoot, e) }));
  const batches = chunk(hydrated, batchSize);

  const next = [...entries];
  let totalCost = 0;
  let totalDuration = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let calls = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const userMessage = buildRefreshUserMessage(batch.map(({ entry, currentCode }) => ({ entry, currentCode })));

    const ac = opts.abortController ?? new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);

    let parsed: z.infer<typeof RefreshResponseSchema>;
    try {
      const result = await runSingleTurnQuery(
        {
          systemPrompt: REFRESH_SYSTEM_PROMPT,
          userMessage,
          model,
          projectRoot,
          abortController: ac,
          composer: 'doc-conflict-refresh',
          primitive: 'doc-conflict-refresh',
          callId: `batch-${bi + 1}`,
          timeoutMs: config.runtime.timeout_per_call * 1000,
          router,
          ...(opts.runDir ? { conversationDir: conversationsDir(opts.runDir) } : {}),
        },
        RefreshResponseSchema,
      );
      parsed = result.data;
      totalCost += result.costUsd;
      totalDuration += result.durationMs;
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalCacheReadTokens += result.cacheReadTokens;
      totalCacheCreationTokens += result.cacheCreationTokens;
      calls++;
      onLlmResponse?.({
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
      } as LlmResponse);
    } catch (err) {
      if (isFatalAuthError(err)) throw err;
      if (isCircuitOpenError(err) || isRateLimitStandbyError(err)) {
        log.warn({ err: err instanceof Error ? err.message : String(err), bi, remaining: batches.length - bi - 1 },
          'doc-conflict-refresh: provider unavailable — aborting batch loop early');
        clearTimeout(timeoutHandle);
        summary.errors += batches.length - bi;
        throw err;
      }
      log.warn({ err: err instanceof Error ? err.message : String(err), bi },
        'doc-conflict-refresh: single-turn query failed — skipping batch');
      summary.errors += batch.length;
      continue;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const decisionsById = new Map(parsed.decisions.map(d => [d.id, d]));
    for (const { idx, entry } of batch) {
      const decision = decisionsById.get(entry.id);
      if (!decision) {
        log.warn({ id: entry.id, bi }, 'doc-conflict-refresh: no decision returned for entry');
        summary.errors++;
        continue;
      }
      const { entry: updated, applied, belowConfidence } = applyDecision(entry, decision, threshold);
      if (applied) {
        next[idx] = updated;
        summary.stillPending--;
        if (decision.decision === 'dismiss') summary.autoResolved.dismiss++;
        else if (decision.decision === 'doc-wins') summary.autoResolved.docWins++;
        else if (decision.decision === 'code-wins') summary.autoResolved.codeWins++;
      } else if (belowConfidence) {
        summary.belowConfidence++;
      }
    }
  }

  if (calls > 0) {
    summary.cost = {
      costUsd: totalCost,
      durationMs: totalDuration,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
      calls,
    };
  }

  return { entries: next, summary };
}
