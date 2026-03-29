// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { ReviewFile, SymbolReview } from '../../schemas/review.js';
import type { UsageGraph } from '../usage-graph.js';
import type { PreResolvedRag } from '../axis-evaluator.js';
import { getSymbolUsage, getTypeOnlySymbolUsage, getTransitiveUsage } from '../usage-graph.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Tier1Context {
  /** Cross-file usage graph for utility axis validation. */
  usageGraph: UsageGraph;
  /** Pre-resolved RAG results keyed by file path. */
  preResolvedRag: Map<string, PreResolvedRag>;
  /** File contents keyed by project-relative path (for JSDoc detection). */
  fileContents: Map<string, string>;
}

export interface Tier1Stats {
  /** Total findings resolved by tier 1. */
  resolved: number;
  /** Total findings confirmed (unchanged but verified). */
  confirmed: number;
  /** Breakdown of resolutions by type. */
  breakdown: {
    deadToUsed: number;
    duplicateToUnique: number;
    overToLean: number;
    undocToDoc: number;
    fixtureSkipped: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RAG_DUPLICATE_THRESHOLD = 0.68;
const TRIVIAL_FUNCTION_MAX_LINES = 2;
const SMALL_FUNCTION_MAX_LINES = 5;
const JSDOC_MIN_LENGTH = 20;
const TYPE_KINDS: ReadonlySet<string> = new Set(['type', 'enum']);
const FIXTURE_PATTERNS = ['__gold-set__', '__fixtures__'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply tier 1 deterministic auto-resolve rules to a ReviewFile.
 *
 * Reclassifies trivially false findings using local data only:
 * - DEAD → USED when usage graph shows importers or transitive usage
 * - DUPLICATE → UNIQUE when no RAG candidate or trivial function
 * - OVER → LEAN when kind is type/enum or function ≤ 5 lines
 * - UNDOCUMENTED → DOCUMENTED when JSDoc exists or type is self-descriptive
 * - Fixture/gold-set files: correction/utility findings skipped
 *
 * Zero network calls. Returns a new ReviewFile (input not mutated).
 */
export function applyTier1(review: ReviewFile, ctx: Tier1Context): ReviewFile & { _tier1Stats?: Tier1Stats } {
  const stats: Tier1Stats = { resolved: 0, confirmed: 0, breakdown: { deadToUsed: 0, duplicateToUnique: 0, overToLean: 0, undocToDoc: 0, fixtureSkipped: 0 } };
  const isFixture = FIXTURE_PATTERNS.some((p) => review.file.includes(p));

  const newSymbols = review.symbols.map((sym) => {
    const s = { ...sym };

    // --- Fixture/gold-set file: skip correction + utility findings ---
    if (isFixture) {
      if (s.correction !== 'OK' && s.correction !== '-') {
        s.correction = 'OK';
        stats.resolved++;
        stats.breakdown.fixtureSkipped++;
      }
      if (s.utility !== 'USED' && s.utility !== '-') {
        s.utility = 'USED';
        stats.resolved++;
        stats.breakdown.fixtureSkipped++;
      }
      s.detail = 'Intentional fixture code';
      return s;
    }

    // --- Utility: DEAD → USED ---
    if (s.utility === 'DEAD' && s.exported) {
      const runtimeImporters = getSymbolUsage(ctx.usageGraph, s.name, review.file);
      if (runtimeImporters.length > 0) {
        s.utility = 'USED';
        s.confidence = 95;
        s.detail = `Auto-resolved: runtime-imported by ${runtimeImporters.length} files`;
        stats.resolved++;
        stats.breakdown.deadToUsed++;
      } else {
        const typeOnlyImporters = getTypeOnlySymbolUsage(ctx.usageGraph, s.name, review.file);
        if (typeOnlyImporters.length > 0) {
          s.utility = 'USED';
          s.confidence = 95;
          s.detail = `Auto-resolved: type-only imported by ${typeOnlyImporters.length} files`;
          stats.resolved++;
          stats.breakdown.deadToUsed++;
        } else {
          const transitiveRefs = getTransitiveUsage(ctx.usageGraph, s.name, review.file);
          if (transitiveRefs.length > 0) {
            s.utility = 'USED';
            s.confidence = 95;
            s.detail = `Auto-resolved: transitively used by ${transitiveRefs.join(', ')}`;
            stats.resolved++;
            stats.breakdown.deadToUsed++;
          }
        }
      }
    }

    // --- Duplication: DUPLICATE → UNIQUE ---
    if (s.duplication === 'DUPLICATE') {
      const symLines = s.line_end - s.line_start + 1;

      // Rule: trivial function (≤ 2 lines) → always unique
      if (symLines <= TRIVIAL_FUNCTION_MAX_LINES) {
        s.duplication = 'UNIQUE';
        s.detail = `Trivial function (≤ ${TRIVIAL_FUNCTION_MAX_LINES} lines)`;
        s.confidence = 90;
        stats.resolved++;
        stats.breakdown.duplicateToUnique++;
      } else {
        // Rule: no RAG candidate with score ≥ threshold → unique
        const fileRag = ctx.preResolvedRag.get(review.file);
        const entry = fileRag?.find((e) => e.symbolName === s.name);
        const topScore = entry?.results?.[0]?.score ?? 0;

        if (topScore < RAG_DUPLICATE_THRESHOLD) {
          s.duplication = 'UNIQUE';
          s.confidence = 90;
          s.detail = `Auto-resolved: no RAG candidate above ${RAG_DUPLICATE_THRESHOLD} threshold`;
          stats.resolved++;
          stats.breakdown.duplicateToUnique++;
        }
      }
    }

    // --- Overengineering: OVER → LEAN ---
    if (s.overengineering === 'OVER') {
      const symLines = s.line_end - s.line_start + 1;

      if (TYPE_KINDS.has(s.kind)) {
        s.overengineering = 'LEAN';
        s.detail = `Auto-resolved: ${s.kind} cannot be over-engineered`;
        stats.resolved++;
        stats.breakdown.overToLean++;
      } else if (symLines <= SMALL_FUNCTION_MAX_LINES) {
        s.overengineering = 'LEAN';
        s.detail = `Auto-resolved: function ≤ ${SMALL_FUNCTION_MAX_LINES} lines`;
        stats.resolved++;
        stats.breakdown.overToLean++;
      }
    }

    // --- Documentation: UNDOCUMENTED → DOCUMENTED ---
    if (s.documentation === 'UNDOCUMENTED' && s.exported) {
      const content = ctx.fileContents.get(review.file);

      if (content) {
        // Check for JSDoc block before the symbol's line
        if (hasJsDocBefore(content, s.line_start)) {
          s.documentation = 'DOCUMENTED';
          s.confidence = 90;
          s.detail = 'Auto-resolved: JSDoc block found before symbol';
          stats.resolved++;
          stats.breakdown.undocToDoc++;
        } else if (TYPE_KINDS.has(s.kind) && isSelfDescriptiveType(content, s)) {
          s.documentation = 'DOCUMENTED';
          s.confidence = 90;
          s.detail = 'Self-descriptive type';
          stats.resolved++;
          stats.breakdown.undocToDoc++;
        }
      }
    }

    // --- Tests: NONE confirmed (no-op, just count) ---
    if (s.tests === 'NONE') {
      stats.confirmed++;
    }

    return s;
  });

  // Recalculate verdict based on reclassified symbols
  const newVerdict = computeVerdict(newSymbols);

  return {
    ...review,
    symbols: newSymbols,
    verdict: newVerdict,
    _tier1Stats: stats,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Check if a JSDoc block (> 20 chars) exists in the lines immediately before
 * the symbol's start line.
 */
function hasJsDocBefore(content: string, symbolLineStart: number): boolean {
  const lines = content.split('\n');
  // Look backwards from the line before the symbol (up to 30 lines back)
  const startIdx = Math.max(0, symbolLineStart - 2); // 0-indexed, line before symbol
  const searchStart = Math.max(0, startIdx - 30);

  let inBlock = false;
  let blockContent = '';

  for (let i = searchStart; i <= startIdx; i++) {
    const line = lines[i]?.trim() ?? '';
    if (line.startsWith('/**')) {
      inBlock = true;
      blockContent = line;
    } else if (inBlock) {
      blockContent += line;
      if (line.includes('*/')) {
        // Found end of JSDoc block — check length
        if (blockContent.length > JSDOC_MIN_LENGTH) {
          return true;
        }
        inBlock = false;
        blockContent = '';
      }
    }
  }

  return false;
}

/**
 * Check if a type/interface/enum is self-descriptive: ≤ 5 fields with
 * readable names (no single-char names, no cryptic abbreviations).
 */
function isSelfDescriptiveType(content: string, sym: SymbolReview): boolean {
  const lines = content.split('\n');
  const bodyLines = lines.slice(sym.line_start - 1, sym.line_end);
  const body = bodyLines.join('\n');

  // Count field-like patterns: "name: type" or "name = value"
  const fieldPattern = /^\s+(\w+)\s*[=:?]/gm;
  const fields: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fieldPattern.exec(body)) !== null) {
    fields.push(m[1]);
  }

  if (fields.length === 0 || fields.length > 5) return false;

  // Check all field names are "self-descriptive" (length > 2, no single char)
  return fields.every((f) => f.length > 2);
}

/**
 * Recompute file verdict from symbol data (mirrors axis-merger logic).
 */
function computeVerdict(symbols: SymbolReview[]): 'CLEAN' | 'NEEDS_REFACTOR' | 'CRITICAL' {
  const CONFIDENCE_THRESHOLD = 60;

  for (const s of symbols) {
    if (s.confidence < CONFIDENCE_THRESHOLD) continue;
    if (s.correction === 'ERROR') return 'CRITICAL';
  }

  for (const s of symbols) {
    if (s.confidence < CONFIDENCE_THRESHOLD) continue;
    if (s.correction === 'NEEDS_FIX') return 'NEEDS_REFACTOR';
    if (s.utility === 'DEAD') return 'NEEDS_REFACTOR';
    if (s.duplication === 'DUPLICATE') return 'NEEDS_REFACTOR';
    if (s.overengineering === 'OVER') return 'NEEDS_REFACTOR';
    if (s.exported && s.documentation === 'UNDOCUMENTED') return 'NEEDS_REFACTOR';
  }

  return 'CLEAN';
}
