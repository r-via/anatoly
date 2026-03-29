// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { ReviewFile } from '../../schemas/review.js';
import type { EscalatedFinding } from './tier2.js';
import {
  applyDeliberation,
  type DeliberationResponse,
} from '../deliberation.js';
import { resolveSystemPrompt } from '../prompt-resolver.js';
import { ALL_AXIS_IDS } from '../axes/index.js';
import type { AxisReclassification, ReclassificationEntry } from '../correction-memory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Shard {
  /** Module directory this shard covers. */
  module: string;
  /** Escalated findings to investigate. */
  findings: EscalatedFinding[];
}

/** Cache entry for a single investigated finding. */
export interface InvestigatedFindingCache {
  original: Record<string, string | number>;
  deliberated: Record<string, string | number>;
  reasoning: string;
  timestamp: string;
}

/** Persistent cache for tier 3 investigation progress. */
export interface RefinementCache {
  investigated: Record<string, InvestigatedFindingCache>;
}

export interface Tier3Context {
  /** Absolute project root path. */
  projectRoot: string;
  /** Run directory for cache persistence. */
  runDir?: string;
  /** Model to use for investigation (default: claude-opus-4-6). */
  model: string;
  /** Abort controller for cancellation. */
  abortController: AbortController;
  /** ReviewFiles keyed by project-relative file path. */
  reviewsByFile: Map<string, ReviewFile>;
  /** Budget cap in USD — shards are skipped once exceeded. */
  budgetUsd: number;
  /** Injectable query function for testability. */
  queryFn: (params: QueryParams) => Promise<QueryResult>;
  /** Injectable record function for testability. Default: recordReclassification. */
  recordFn?: (projectRoot: string, entry: Omit<ReclassificationEntry, 'recorded_at'>) => void;
  /** Progress callback fired after each shard completes. */
  onShardDone?: (shardIndex: number, totalShards: number, result: ShardResult) => void;
}

export interface QueryParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  projectRoot: string;
  abortController: AbortController;
}

export interface QueryResult {
  data: DeliberationResponse;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  transcript: string;
}

export interface ShardResult {
  module: string;
  status: 'ok' | 'failed' | 'skipped';
  investigated: number;
  confirmed: number;
  reclassified: number;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface Tier3Result {
  investigated: number;
  confirmed: number;
  reclassified: number;
  totalCostUsd: number;
  totalDurationMs: number;
  budgetExceeded: boolean;
  shardResults: ShardResult[];
  /** ReviewFiles updated by tier 3 investigation. */
  updatedReviews: Map<string, ReviewFile>;
}

// ---------------------------------------------------------------------------
// Refinement cache I/O
// ---------------------------------------------------------------------------

function findingCacheKey(file: string, symbol: string, axis: string): string {
  return `${file}::${symbol}::${axis}`;
}

function cachePath(runDir: string): string {
  return join(runDir, 'refinement-cache.json');
}

export function loadRefinementCache(runDir: string): RefinementCache {
  try {
    const raw = readFileSync(cachePath(runDir), 'utf-8');
    return JSON.parse(raw) as RefinementCache;
  } catch {
    return { investigated: {} };
  }
}

function saveRefinementCache(runDir: string, cache: RefinementCache): void {
  try {
    mkdirSync(dirname(cachePath(runDir)), { recursive: true });
    writeFileSync(cachePath(runDir), JSON.stringify(cache, null, 2) + '\n');
  } catch {
    // non-critical
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FINDINGS_PER_SHARD = 20;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Group escalated findings into shards by directory.
 *
 * Groups by parent directory, then splits shards exceeding MAX_FINDINGS_PER_SHARD.
 * Small modules are kept as separate shards (no merging across directories for clarity).
 */
export function buildShards(findings: EscalatedFinding[]): Shard[] {
  if (findings.length === 0) return [];

  // Group by directory
  const byDir = new Map<string, EscalatedFinding[]>();
  for (const f of findings) {
    const dir = dirname(f.file);
    const list = byDir.get(dir) ?? [];
    list.push(f);
    byDir.set(dir, list);
  }

  const shards: Shard[] = [];
  for (const [dir, dirFindings] of byDir) {
    // Split large directories into chunks of MAX_FINDINGS_PER_SHARD
    if (dirFindings.length > MAX_FINDINGS_PER_SHARD) {
      for (let i = 0; i < dirFindings.length; i += MAX_FINDINGS_PER_SHARD) {
        shards.push({
          module: dir,
          findings: dirFindings.slice(i, i + MAX_FINDINGS_PER_SHARD),
        });
      }
    } else {
      shards.push({ module: dir, findings: dirFindings });
    }
  }

  return shards;
}

/**
 * Run tier 3 agentic investigation on shards of escalated findings.
 *
 * For each shard, builds a prompt with the claims to verify, calls the
 * investigation model (Opus), applies reclassifications to ReviewFiles,
 * and records memory entries.
 *
 * Features:
 * - Error isolation per shard (failed shards don't block others)
 * - Budget cap (stops processing when cumulative cost exceeds limit)
 * - Consolidation report with investigated/confirmed/reclassified counts
 */
export async function runTier3(shards: Shard[], ctx: Tier3Context): Promise<Tier3Result> {
  const shardResults: ShardResult[] = [];
  const updatedReviews = new Map<string, ReviewFile>();
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let budgetExceeded = false;

  // Load refinement cache — skip findings already investigated in a previous run/attempt
  const cache = ctx.runDir ? loadRefinementCache(ctx.runDir) : { investigated: {} };
  let cacheHits = 0;

  // Filter already-cached findings from shards and apply cached results
  const filteredShards: Shard[] = [];
  for (const shard of shards) {
    const uncached: EscalatedFinding[] = [];
    for (const f of shard.findings) {
      const key = findingCacheKey(f.file, f.symbolName, f.axis);
      const cached = cache.investigated[key];
      if (cached) {
        cacheHits++;
        // Apply cached deliberation to the review
        const review = updatedReviews.get(f.file) ?? ctx.reviewsByFile.get(f.file);
        if (review) {
          const sym = review.symbols.find(s => s.name === f.symbolName);
          if (sym && f.axis in cached.deliberated) {
            (sym as Record<string, unknown>)[f.axis] = cached.deliberated[f.axis];
            if (typeof cached.deliberated.confidence === 'number') {
              sym.confidence = cached.deliberated.confidence as number;
            }
            updatedReviews.set(f.file, { ...review });
          }
        }
      } else {
        uncached.push(f);
      }
    }
    if (uncached.length > 0) {
      filteredShards.push({ module: shard.module, findings: uncached });
    }
  }

  for (const shard of filteredShards) {
    // Budget check before starting shard
    if (totalCostUsd >= ctx.budgetUsd) {
      budgetExceeded = true;
      const skipped: ShardResult = {
        module: shard.module,
        status: 'skipped',
        investigated: 0,
        confirmed: 0,
        reclassified: 0,
        costUsd: 0,
        durationMs: 0,
        error: `Budget exceeded ($${totalCostUsd.toFixed(2)} >= $${ctx.budgetUsd})`,
      };
      shardResults.push(skipped);
      ctx.onShardDone?.(shardResults.length, shards.length, skipped);
      continue;
    }

    try {
      const result = await investigateShard(shard, ctx, updatedReviews);
      totalCostUsd += result.costUsd;
      totalDurationMs += result.durationMs;
      shardResults.push(result);
      ctx.onShardDone?.(shardResults.length, filteredShards.length, result);

      // Persist each investigated finding to cache immediately
      if (ctx.runDir && result.deliberation) {
        for (const sym of result.deliberation.symbols) {
          for (const axis of DELIBERATION_AXES) {
            const orig = sym.original[axis];
            if (!orig || orig === '-') continue;
            // Find the matching escalated finding to get the file path
            const finding = shard.findings.find(f => f.symbolName === sym.name && f.axis === axis);
            if (!finding) continue;
            const key = findingCacheKey(finding.file, sym.name, axis);
            cache.investigated[key] = {
              original: sym.original as Record<string, string | number>,
              deliberated: sym.deliberated as Record<string, string | number>,
              reasoning: sym.reasoning,
              timestamp: new Date().toISOString(),
            };
          }
        }
        saveRefinementCache(ctx.runDir, cache);
      }
    } catch (err) {
      const failed: ShardResult = {
        module: shard.module,
        status: 'failed',
        investigated: 0,
        confirmed: 0,
        reclassified: 0,
        costUsd: 0,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
      shardResults.push(failed);
      ctx.onShardDone?.(shardResults.length, shards.length, failed);
    }
  }

  // Consolidation
  let investigated = 0;
  let confirmed = 0;
  let reclassified = 0;

  for (const sr of shardResults) {
    investigated += sr.investigated;
    confirmed += sr.confirmed;
    reclassified += sr.reclassified;
  }

  return {
    investigated,
    confirmed,
    reclassified,
    totalCostUsd,
    totalDurationMs,
    budgetExceeded,
    shardResults,
    updatedReviews,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DELIBERATION_AXES = ['correction', 'utility', 'duplication', 'overengineering', 'tests', 'documentation'] as const;
type DeliberationAxis = (typeof DELIBERATION_AXES)[number];

/**
 * Investigate a single shard — build prompt, call LLM, apply results.
 */
async function investigateShard(
  shard: Shard,
  ctx: Tier3Context,
  updatedReviews: Map<string, ReviewFile>,
): Promise<ShardResult & { deliberation?: DeliberationResponse }> {
  const systemPrompt = buildTier3SystemPrompt();
  const userMessage = buildTier3UserMessage(shard, ctx.reviewsByFile);

  const queryResult = await ctx.queryFn({
    systemPrompt,
    userMessage,
    model: ctx.model,
    projectRoot: ctx.projectRoot,
    abortController: ctx.abortController,
  });

  const deliberation = queryResult.data;

  // Count confirmed vs reclassified
  let confirmedCount = 0;
  let reclassifiedCount = 0;

  for (const sym of deliberation.symbols) {
    let hasReclassification = false;
    for (const axis of DELIBERATION_AXES) {
      const orig = sym.original[axis];
      const delib = sym.deliberated[axis];
      if (orig && delib && orig !== delib) {
        hasReclassification = true;
        break;
      }
    }

    if (hasReclassification) {
      reclassifiedCount++;
    } else {
      confirmedCount++;
    }
  }

  // Apply deliberation results to each affected ReviewFile
  const affectedFiles = new Set(shard.findings.map((f) => f.file));
  for (const filePath of affectedFiles) {
    const review = updatedReviews.get(filePath) ?? ctx.reviewsByFile.get(filePath);
    if (!review) continue;

    // Filter deliberation to only symbols from this file
    const fileFindings = shard.findings.filter((f) => f.file === filePath);
    const fileSymbolNames = new Set(fileFindings.map((f) => f.symbolName));
    const fileDeliberation: DeliberationResponse = {
      ...deliberation,
      symbols: deliberation.symbols.filter((s) => fileSymbolNames.has(s.name)),
    };

    if (fileDeliberation.symbols.length === 0) continue;

    // Apply using the existing applyDeliberation (reuse from deliberation.ts)
    // but handle recordFn separately for testability
    const updated = applyDeliberation(review, fileDeliberation);
    updatedReviews.set(filePath, updated);

    // Record reclassifications via injectable recordFn
    if (ctx.recordFn) {
      for (const sym of fileDeliberation.symbols) {
        const axisReclassifications: AxisReclassification[] = [];
        for (const axis of DELIBERATION_AXES) {
          const orig = sym.original[axis];
          const delib = sym.deliberated[axis];
          if (orig && delib && orig !== delib) {
            axisReclassifications.push({ axis, from: String(orig), to: String(delib) });
          }
        }
        if (axisReclassifications.length > 0) {
          ctx.recordFn(ctx.projectRoot, {
            symbol: sym.name,
            reclassifications: axisReclassifications,
            original_detail: sym.reasoning.slice(0, 200),
            reason: `Tier 3 investigation: ${sym.reasoning}`,
          });
        }
      }
    }
  }

  return {
    module: shard.module,
    status: 'ok',
    investigated: deliberation.symbols.length,
    confirmed: confirmedCount,
    reclassified: reclassifiedCount,
    costUsd: queryResult.costUsd,
    durationMs: queryResult.durationMs,
    deliberation,
  };
}

/**
 * Build tier 3 system prompt.
 * Reuses the deliberation system prompt as base, since the output format is identical.
 */
function buildTier3SystemPrompt(): string {
  const raw = resolveSystemPrompt('refinement.tier3-investigation');
  return raw.replace('{{AXIS_LIST}}', ALL_AXIS_IDS.join(', '));
}

/**
 * Build the user message for a shard investigation.
 *
 * Presents findings as claims to verify (not the full source code).
 * The agent can use Read/Grep/Glob to investigate each claim.
 */
function buildTier3UserMessage(
  shard: Shard,
  reviewsByFile: Map<string, ReviewFile>,
): string {
  const parts: string[] = [];

  parts.push(`## Tier 3 Investigation — Module: ${shard.module}

You are investigating ${shard.findings.length} escalated finding(s) in the \`${shard.module}\` module.
Each finding below is a claim from the automated review that needs empirical verification.

**Your task:** For each claim, read the actual source code and verify whether the finding is correct.
- If the finding is correct, confirm it (keep original values).
- If the finding is a false positive, reclassify it with evidence (line numbers, grep results).
- Produce a DeliberationResponse JSON with your verdicts.`);

  // Group findings by file for clarity
  const byFile = new Map<string, EscalatedFinding[]>();
  for (const f of shard.findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  for (const [filePath, fileFindings] of byFile) {
    parts.push(`### File: \`${filePath}\``);

    for (const f of fileFindings) {
      const review = reviewsByFile.get(filePath);
      const sym = review?.symbols.find(s => s.name === f.symbolName);
      const confidence = sym?.confidence ?? '?';
      const detail = sym?.detail ? ` | Detail: "${sym.detail.slice(0, 150)}"` : '';
      parts.push(`- **${f.symbolName}**: \`${f.axis}\` = \`${f.value}\` (confidence: ${confidence})${detail}`);
      parts.push(`  Escalation reason: ${f.reason}`);
    }
  }

  parts.push(`## What to do

1. Read each file listed above using the Read tool
2. Verify each claim against the actual source code
3. Grep for usages if a symbol is claimed DEAD
4. Check configs/runtime values if a finding involves constants
5. Produce a single JSON object with your verdicts at the end`);

  return parts.join('\n\n');
}
