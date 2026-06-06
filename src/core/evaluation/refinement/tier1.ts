// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ReviewFile, SymbolReview } from '../../../schemas/review.js';
import type { UsageGraph } from '../../scanning/index.js';
import type { PreResolvedRag } from '../contract.js';
import { getSymbolUsage, getTypeOnlySymbolUsage, getTransitiveUsage } from '../../scanning/index.js';
import { setAxisSegment, getAxisSegmentText } from './detail-segment.js';
import { computeVerdict } from './verdict.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Tier1Context {
  /** Cross-file usage graph for utility axis validation. */
  usageGraph: UsageGraph;
  /** Pre-resolved RAG results keyed by file path. */
  preResolvedRag: Map<string, PreResolvedRag>;
  /** File contents keyed by project-relative path (for JSDoc detection). Loaded lazily if empty. */
  fileContents: Map<string, string>;
  /** Project root for lazy file loading. */
  projectRoot?: string;
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
    leanToOver: number;
    undocToDoc: number;
    fixtureSkipped: number;
    correctionImportResolved: number;
    correctionBoundsResolved: number;
    correctionGeneratedDowngraded: number;
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
/** Minimum size for an abstraction to be a credible over-engineering target. */
const OVER_ABSTRACTION_MIN_LINES = 15;
/** Names that are legitimately imported from a single site (entry points). */
const ENTRY_POINT_NAMES: ReadonlySet<string> = new Set(['main', 'index', 'app', 'bootstrap', 'setup', 'init', 'run', 'start']);

/**
 * Lazy-load a project-relative file's content, caching it on the context. Shared
 * by the over-engineering heritage check and the documentation JSDoc check. When
 * `projectRoot` is absent or the file cannot be read, returns `undefined` (the
 * callers degrade to their prior, content-free behaviour).
 */
function loadFileContent(ctx: Tier1Context, file: string): string | undefined {
  let content = ctx.fileContents.get(file);
  if (!content && ctx.projectRoot) {
    try {
      content = readFileSync(resolve(ctx.projectRoot, file), 'utf-8');
      ctx.fileContents.set(file, content);
    } catch { /* file may have been deleted */ }
  }
  return content;
}

/**
 * Whether `className`'s declaration in `source` carries a heritage clause
 * (`extends`/`implements`). A class fulfilling a shared contract is a
 * Strategy/Adapter/plug-in implementation, legitimately registered through a
 * single registry, so a ≤1-importer count is not evidence of a single-client
 * over-abstraction. Guards the LEAN→OVER auto-promotion against the
 * polymorphic-family false positive. Returns `false` when the source is
 * unavailable (the guard becomes inert, preserving prior behaviour).
 */
export function classHasHeritageClause(source: string | undefined, className: string): boolean {
  if (!source) return false;
  const name = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `class Name [<generics>] (extends|implements) ...`, scanning only up to the
  // class body `{` so an unrelated later `extends`/`implements` cannot match.
  return new RegExp(`\\bclass\\s+${name}\\b[^{]*\\b(?:extends|implements)\\b`).test(source);
}
const GENERATED_MARKERS = ['@generated', 'DO NOT EDIT', 'AUTO-GENERATED', 'BEGIN GENERATED', 'auto-generated'];
const MISSING_IMPORT_PATTERNS = /\b(?:missing|undefined|not (?:defined|found|exported)|does not exist|cannot find)\b.*\b(?:function|import|module|export|method|symbol)\b|\b(?:function|import|module|export|method|symbol)\b.*\b(?:missing|undefined|not (?:defined|found|exported)|does not exist|cannot find)\b/i;
const BOUNDS_PATTERNS = /\b(?:out[- ]of[- ]bounds|array.*(?:has|only|contains)\s+\d+.*(?:but|while|however).*\d+|index\s+\d+.*(?:but|while).*length\s+\d+)\b/i;

/**
 * For every axis whose verdict can synthesize an action (axis-merger's
 * `synthesizeActionsFromSymbols`), the set of verdicts that still JUSTIFY that
 * action. After tier1 resolves a symbol's verdict, an action survives only if
 * the symbol's current verdict on the action's `source` axis is still in this
 * set — purging any action tier1 made stale, for every axis at once. Sources
 * not listed here (doc divergences, etc.) are never purged.
 */
const ACTIONABLE_VERDICTS: Record<string, ReadonlySet<string>> = {
  utility: new Set(['DEAD', 'LOW_VALUE']),
  duplication: new Set(['DUPLICATE']),
  overengineering: new Set(['OVER']),
  documentation: new Set(['UNDOCUMENTED', 'PARTIAL']),
};

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
 *
 * Zero network calls. Returns a new ReviewFile (input not mutated).
 */
export function applyTier1(review: ReviewFile, ctx: Tier1Context): ReviewFile & { _tier1Stats?: Tier1Stats } {
  const stats: Tier1Stats = { resolved: 0, confirmed: 0, breakdown: { deadToUsed: 0, duplicateToUnique: 0, overToLean: 0, leanToOver: 0, undocToDoc: 0, fixtureSkipped: 0, correctionImportResolved: 0, correctionBoundsResolved: 0, correctionGeneratedDowngraded: 0 } };

  // Detect generated files: check for markers in file content
  let fileContent = ctx.fileContents.get(review.file);
  if (!fileContent && ctx.projectRoot) {
    try {
      fileContent = readFileSync(resolve(ctx.projectRoot, review.file), 'utf-8');
      ctx.fileContents.set(review.file, fileContent);
    } catch { /* file may have been deleted */ }
  }
  const isGenerated = fileContent ? GENERATED_MARKERS.some((m) => fileContent!.includes(m)) : false;

  // Stale synthesized actions (created from the pre-tier1 verdict) are purged
  // declaratively after the symbol pass, via ACTIONABLE_VERDICTS — no per-axis
  // bookkeeping. See the purge step below.
  /** Symbols promoted LEAN → OVER by the usage-graph rule (need action synthesis). */
  const promotedOverengineering: SymbolReview[] = [];

  const newSymbols = review.symbols.map((sym) => {
    const s = { ...sym };

    // --- Correction: missing import → OK when import resolves on disk ---
    if ((s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') && MISSING_IMPORT_PATTERNS.test(s.detail)) {
      if (fileContent && ctx.projectRoot) {
        const resolved = verifyCorrectionImport(s.detail, fileContent, review.file, ctx.projectRoot);
        if (resolved) {
          const oldVerdict = s.correction;
          s.correction = 'OK';
          s.confidence = 95;
          s.detail = setAxisSegment(s.detail, oldVerdict, 'OK', `Auto-resolved: import verified on disk (${resolved})`);
          stats.resolved++;
          stats.breakdown.correctionImportResolved++;
        }
      }
    }

    // --- Correction: array out-of-bounds → OK when sizes match statically ---
    if ((s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') && BOUNDS_PATTERNS.test(s.detail)) {
      if (fileContent) {
        const match = verifyArrayBounds(s.detail, fileContent, s.line_start, s.line_end);
        if (match) {
          const oldVerdict = s.correction;
          s.correction = 'OK';
          s.confidence = 95;
          s.detail = setAxisSegment(s.detail, oldVerdict, 'OK', `Auto-resolved: ${match}`);
          stats.resolved++;
          stats.breakdown.correctionBoundsResolved++;
        }
      }
    }

    // --- Correction: generated file → downgrade ERROR to NEEDS_FIX ---
    if (isGenerated && s.correction === 'ERROR') {
      const originalErrorText = getAxisSegmentText(s.detail, 'ERROR');
      const newText = originalErrorText
        ? `Downgraded: generated/auto-generated code (was ERROR: ${originalErrorText})`
        : `Downgraded: generated/auto-generated code`;
      s.correction = 'NEEDS_FIX';
      s.confidence = Math.min(s.confidence, 55);
      s.detail = setAxisSegment(s.detail, 'ERROR', 'NEEDS_FIX', newText);
      stats.resolved++;
      stats.breakdown.correctionGeneratedDowngraded++;
    }

    // --- Utility: DEAD → USED ---
    if (s.utility === 'DEAD') {
      let resolved = false;

      if (s.exported) {
        const runtimeImporters = getSymbolUsage(ctx.usageGraph, s.name, review.file);
        if (runtimeImporters.length > 0) {
          s.utility = 'USED';
          s.confidence = 95;
          s.detail = setAxisSegment(s.detail, 'DEAD', 'USED', `Auto-resolved: runtime-imported by ${runtimeImporters.length} files`);
          resolved = true;
        } else {
          const typeOnlyImporters = getTypeOnlySymbolUsage(ctx.usageGraph, s.name, review.file);
          if (typeOnlyImporters.length > 0) {
            s.utility = 'USED';
            s.confidence = 95;
            s.detail = setAxisSegment(s.detail, 'DEAD', 'USED', `Auto-resolved: type-only imported by ${typeOnlyImporters.length} files`);
            resolved = true;
          }
        }
      }

      if (!resolved) {
        // Check transitive usage (works for both exported and non-exported)
        const transitiveRefs = getTransitiveUsage(ctx.usageGraph, s.name, review.file);
        if (transitiveRefs.length > 0) {
          s.utility = 'USED';
          s.confidence = 95;
          s.detail = setAxisSegment(s.detail, 'DEAD', 'USED', `Auto-resolved: transitively used by ${transitiveRefs.join(', ')}`);
          resolved = true;
        }
      }

      if (!resolved && !s.exported) {
        // Non-exported: check intra-file references
        const key = `${review.file}::${s.name}`;
        const intraRefs = ctx.usageGraph.intraFileRefs.get(key);
        if (intraRefs && intraRefs.size > 0) {
          s.utility = 'USED';
          s.confidence = 95;
          s.detail = setAxisSegment(s.detail, 'DEAD', 'USED', `Auto-resolved: referenced by ${[...intraRefs].join(', ')} in same file`);
          resolved = true;
        }
      }

      if (resolved) {
        stats.resolved++;
        stats.breakdown.deadToUsed++;
      }
    }

    // --- Duplication: DUPLICATE → UNIQUE ---
    //
    // Tier-1 heuristics only downgrade a DUPLICATE verdict when the
    // upstream evaluator did NOT commit to specific evidence. A populated
    // `duplicate_target` means the semantic-analysis phase (LLM) pointed
    // at a concrete match; cheap post-hoc heuristics (function length, RAG
    // embedding score) must not override that. In particular, the
    // RAG-threshold rule would otherwise silently discard the LLM's
    // verdict on exactly the cases where embeddings underperform semantic
    // analysis — refactors where the two sides share algorithmic intent
    // but textually diverge (renamed variables, different generics,
    // different idioms). Those are the cases the LLM is *most* useful for.
    if (s.duplication === 'DUPLICATE' && !s.duplicate_target) {
      const symLines = s.line_end - s.line_start + 1;

      // Rule: trivial function (≤ 2 lines) → always unique
      if (symLines <= TRIVIAL_FUNCTION_MAX_LINES) {
        s.duplication = 'UNIQUE';
        s.detail = setAxisSegment(s.detail, 'DUPLICATE', 'UNIQUE', `Trivial function (≤ ${TRIVIAL_FUNCTION_MAX_LINES} lines)`);
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
          s.detail = setAxisSegment(s.detail, 'DUPLICATE', 'UNIQUE', `Auto-resolved: no RAG candidate above ${RAG_DUPLICATE_THRESHOLD} threshold`);
          stats.resolved++;
          stats.breakdown.duplicateToUnique++;
        }
      }
    }

    // --- Duplication: DUPLICATE → UNIQUE when the LLM contradicts itself ---
    //
    // The block above protects a populated `duplicate_target`, trusting the
    // LLM's semantic match where embeddings underperform. That trust is void
    // when the LLM's OWN rationale negates its verdict: a stated similarity
    // below the documented 0.82 threshold together with "differs"/"below
    // threshold"/"not a duplicate" language (the osteovienne Stat↔Metric false
    // positive: RAG 0.744, "actual code differs significantly"). Demote AND
    // clear the target — the schema invariant (duplicate_target ⇒ DUPLICATE)
    // would otherwise re-promote the verdict from the surviving target.
    if (s.duplication === 'DUPLICATE' && s.duplicate_target
        && isSelfContradictingDuplicate(s.detail, s.duplicate_target.similarity)) {
      s.duplication = 'UNIQUE';
      s.duplicate_target = undefined;
      s.confidence = 90;
      s.detail = setAxisSegment(s.detail, 'DUPLICATE', 'UNIQUE', 'Auto-resolved: flagged DUPLICATE but the rationale is below the 0.82 threshold and notes the code differs');
      stats.resolved++;
      stats.breakdown.duplicateToUnique++;
    }

    // --- Overengineering: OVER → LEAN ---
    if (s.overengineering === 'OVER') {
      const symLines = s.line_end - s.line_start + 1;

      if (TYPE_KINDS.has(s.kind)) {
        s.overengineering = 'LEAN';
        s.detail = setAxisSegment(s.detail, 'OVER', 'LEAN', `Auto-resolved: ${s.kind} cannot be over-engineered`);
        stats.resolved++;
        stats.breakdown.overToLean++;
      } else if (symLines <= SMALL_FUNCTION_MAX_LINES) {
        s.overengineering = 'LEAN';
        s.detail = setAxisSegment(s.detail, 'OVER', 'LEAN', `Auto-resolved: function ≤ ${SMALL_FUNCTION_MAX_LINES} lines`);
        stats.resolved++;
        stats.breakdown.overToLean++;
      }
    }

    // --- Overengineering: LEAN → OVER based on low importer count ---
    // An exported class with ≤1 importer is almost always an abstraction
    // built for a single client (factory, strategy, emitter). The LLM often
    // misses this because each piece looks well-structured in isolation;
    // only the usage count exposes the waste. We exclude entry-point names
    // and symbols below OVER_ABSTRACTION_MIN_LINES to cut trivial noise.
    if (s.overengineering === 'LEAN' && s.exported && s.kind === 'class') {
      const symLines = s.line_end - s.line_start + 1;
      if (symLines >= OVER_ABSTRACTION_MIN_LINES && !ENTRY_POINT_NAMES.has(s.name.toLowerCase())) {
        const importers = getSymbolUsage(ctx.usageGraph, s.name, review.file);
        const typeImporters = getTypeOnlySymbolUsage(ctx.usageGraph, s.name, review.file);
        const totalImporters = importers.length + typeImporters.length;
        // A class that implements an interface or extends a base class fulfils a
        // shared contract — a Strategy/Adapter/plug-in implementation. Such a
        // family is legitimately registered through a SINGLE registry file, so
        // each member reads as "imported by 1 file" without being a
        // single-client over-abstraction. Skipping promotion here kills the
        // polymorphic-family false positive (e.g. the 10 language adapters all
        // implementing LanguageAdapter, the axis evaluators implementing
        // AxisEvaluator, the transports implementing LlmTransport — each listed
        // under one registry yet flagged OVER on importer count alone). The
        // LLM's LEAN verdict stands. Heritage is read from source; when the file
        // is unavailable the guard is inert and prior behaviour is preserved.
        if (totalImporters <= 1 && !classHasHeritageClause(loadFileContent(ctx, review.file), s.name)) {
          s.overengineering = 'OVER';
          s.confidence = 80;
          s.detail = setAxisSegment(s.detail, 'LEAN', 'OVER', `Auto-promoted: exported class imported by ${totalImporters} file${totalImporters === 1 ? '' : 's'} — abstraction built for a single client`);
          promotedOverengineering.push(s);
          stats.resolved++;
          stats.breakdown.leanToOver++;
        }
      }
    }

    // --- Documentation: UNDOCUMENTED → DOCUMENTED ---
    if (s.documentation === 'UNDOCUMENTED' && s.exported) {
      const content = loadFileContent(ctx, review.file);

      if (content) {
        // Check for JSDoc block before the symbol's line
        if (hasJsDocBefore(content, s.line_start)) {
          s.documentation = 'DOCUMENTED';
          s.confidence = 90;
          s.detail = setAxisSegment(s.detail, 'UNDOCUMENTED', 'DOCUMENTED', 'Auto-resolved: JSDoc block found before symbol');
          stats.resolved++;
          stats.breakdown.undocToDoc++;
        } else if (TYPE_KINDS.has(s.kind) && isSelfDescriptiveType(content, s)) {
          s.documentation = 'DOCUMENTED';
          s.confidence = 90;
          s.detail = setAxisSegment(s.detail, 'UNDOCUMENTED', 'DOCUMENTED', 'Self-descriptive type');
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

  // Purge synthesized actions that no longer match a symbol verdict.
  // Invariant: an action with source=X targeting symbol S requires that
  // S's X-axis verdict still justifies the action.
  const verdictBySymbol = new Map(newSymbols.map((s) => [s.name, s]));
  const purgedActions = review.actions.filter((a) => {
    if (!a.target_symbol || !a.source) return true;
    const actionable = ACTIONABLE_VERDICTS[a.source];
    if (!actionable) return true; // source is not a verdict-driven axis — never purge
    const sym = verdictBySymbol.get(a.target_symbol);
    if (!sym) return true; // can't evaluate the verdict — keep
    const verdict = (sym as unknown as Record<string, unknown>)[a.source];
    return actionable.has(String(verdict)); // keep only while the verdict still justifies it
  });

  // Synthesize actions for LEAN → OVER promotions (axis-merger ran before
  // tier1 so these symbols had no OVER action at merge time).
  const nextId = purgedActions.reduce((max, a) => Math.max(max, a.id), 0) + 1;
  const promotedActions = promotedOverengineering.map((s, i) => ({
    id: nextId + i,
    description: `Simplify: \`${s.name}\` is over-engineered`,
    severity: 'medium' as const,
    effort: 'small' as const,
    category: 'hygiene' as const,
    source: 'overengineering' as const,
    target_symbol: s.name,
    target_lines: `L${s.line_start}-L${s.line_end}`,
  }));
  const newActions = promotedActions.length > 0
    ? [...purgedActions, ...promotedActions]
    : purgedActions;

  return {
    ...review,
    symbols: newSymbols,
    actions: newActions,
    verdict: newVerdict,
    _tier1Stats: stats,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Phrases an LLM uses when its rationale negates its own DUPLICATE verdict. */
const DUPLICATE_NEGATION = /\b(?:below (?:the )?[\d.]*\s*(?:duplicate )?threshold|differs?\s+(?:significantly|substantially|materially)|not\s+(?:a\s+|truly\s+)?(?:real\s+|true\s+)?duplicate|(?:different|distinct)\s+(?:api|contract|props|implementation|purpose))\b/i;
/** The symbol's own stated similarity score (e.g. "RAG score 0.744"), not the threshold it cites. */
const DUPLICATE_SCORE = /(?:rag\s*score|similarity\s*score|score|similarity)\D{0,15}(0?\.\d+)/i;

/**
 * Whether a DUPLICATE verdict is contradicted by its own rationale.
 *
 * A populated `duplicate_target` normally protects DUPLICATE from tier1's
 * cheap demotions (embeddings underperform on semantic refactors). But the
 * LLM sometimes flags DUPLICATE while its detail/similarity text negates it:
 * a stated similarity below the documented 0.82 threshold AND explicit
 * "differs"/"below threshold"/"not a duplicate"/"different API" language.
 * That self-contradiction is a false positive, not a match embeddings missed.
 * Both signals are required, so a confident low-RAG semantic match (no
 * sub-0.82 score stated, no negation language) is left untouched.
 */
export function isSelfContradictingDuplicate(detail: string, similarity?: string): boolean {
  const text = `${detail} ${similarity ?? ''}`;
  if (!DUPLICATE_NEGATION.test(text)) return false;
  const m = text.match(DUPLICATE_SCORE);
  if (!m) return false;
  return parseFloat(m[1]) < 0.82;
}

/**
 * Verify that a "missing import" correction finding is a false positive
 * by checking if the referenced symbol's import actually resolves on disk.
 *
 * Extracts the symbol name from the finding detail, finds the corresponding
 * import statement in the file, and resolves the import path to verify it exists.
 *
 * @returns The resolved import description if verified (false positive), or null if unverified.
 */
function verifyCorrectionImport(
  detail: string,
  fileContent: string,
  filePath: string,
  projectRoot: string,
): string | null {
  // Extract potential symbol names from the detail text (backtick-quoted or camelCase identifiers)
  const symbolNames = new Set<string>();
  for (const m of detail.matchAll(/`(\w+)`/g)) {
    symbolNames.add(m[1]);
  }
  // Also try to find camelCase/PascalCase identifiers mentioned as "missing"
  for (const m of detail.matchAll(/(?:missing|undefined)\s+(?:function|method|import)?\s*`?(\w+)`?/gi)) {
    symbolNames.add(m[1]);
  }

  if (symbolNames.size === 0) return null;

  // Check each symbol against import statements in the file
  const importRe = /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  const fileAbsPath = resolve(projectRoot, filePath);
  const fileDir = dirname(fileAbsPath);

  for (const match of fileContent.matchAll(importRe)) {
    const namedImports = match[1];
    const defaultImport = match[2];
    const specifier = match[3];

    // Check if any mentioned symbol is in this import
    const importedNames = new Set<string>();
    if (namedImports) {
      for (const name of namedImports.split(',')) {
        const clean = name.trim().split(/\s+as\s+/)[0].trim();
        if (clean) importedNames.add(clean);
      }
    }
    if (defaultImport) importedNames.add(defaultImport);

    const matchedSymbol = [...symbolNames].find((s) => importedNames.has(s));
    if (!matchedSymbol) continue;

    // Resolve the import path
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue; // skip node_modules

    let base = resolve(fileDir, specifier);
    if (base.endsWith('.js')) base = base.slice(0, -3);

    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      if (existsSync(base + ext)) {
        // Verify the symbol is actually exported from that file
        try {
          const targetContent = readFileSync(base + ext, 'utf-8');
          if (targetContent.includes(matchedSymbol)) {
            return `${matchedSymbol} found in ${specifier}`;
          }
        } catch { /* unreadable — skip */ }
      }
    }
    // Also try index file
    for (const ext of ['.ts', '.tsx', '.js']) {
      const indexPath = resolve(base, `index${ext}`);
      if (existsSync(indexPath)) {
        try {
          const targetContent = readFileSync(indexPath, 'utf-8');
          if (targetContent.includes(matchedSymbol)) {
            return `${matchedSymbol} found in ${specifier}/index`;
          }
        } catch { /* unreadable */ }
      }
    }
  }

  return null;
}

/**
 * Verify that an "out of bounds" correction finding is a false positive
 * by checking if the arrays referenced in the code have matching lengths.
 *
 * Looks for array literals near the symbol's code and compares their element counts.
 * If two arrays referenced in the same loop have the same static length, the
 * finding is a false positive.
 *
 * @returns A description of the match if verified (false positive), or null if unverified.
 */
function verifyArrayBounds(
  detail: string,
  fileContent: string,
  lineStart: number,
  lineEnd: number,
): string | null {
  const lines = fileContent.split('\n');

  // Extract array names mentioned in the detail
  const arrayNames: string[] = [];
  for (const m of detail.matchAll(/`(\w+)`/g)) {
    arrayNames.push(m[1]);
  }
  // Also try to extract from "ARRAY has N elements" patterns
  for (const m of detail.matchAll(/(\w+)\s+(?:array\s+)?(?:has|only|contains)\s+\d+/gi)) {
    arrayNames.push(m[1]);
  }

  if (arrayNames.length === 0) return null;

  // Find static array lengths by looking for array literal definitions
  const arraySizes = new Map<string, number>();

  // Search the full file for const ARRAY_NAME = [...]
  const fullText = fileContent;
  for (const name of arrayNames) {
    // Match: const NAME = [\n...\n];  — count elements by looking at the bracket-enclosed content
    const arrayDefRe = new RegExp(`(?:const|let|var|export\\s+const)\\s+${name}\\s*(?::[^=]+=|=)\\s*\\[`, 'g');
    const match = arrayDefRe.exec(fullText);
    if (!match) continue;

    // Find the closing bracket
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let i = startIdx;
    while (i < fullText.length && depth > 0) {
      if (fullText[i] === '[') depth++;
      else if (fullText[i] === ']') depth--;
      i++;
    }

    if (depth === 0) {
      const arrayContent = fullText.slice(startIdx, i - 1);
      // Count top-level elements (split by commas at depth 0)
      let elemCount = 0;
      let d = 0;
      let hasContent = false;
      for (const ch of arrayContent) {
        if (ch === '[' || ch === '(' || ch === '{') d++;
        else if (ch === ']' || ch === ')' || ch === '}') d--;
        else if (ch === ',' && d === 0) elemCount++;
        if (!hasContent && ch.trim()) hasContent = true;
      }
      // Bump for the final element only when there is NO trailing comma. With a
      // trailing comma the loop already counted it, so an unconditional +1
      // over-counts by one — making a trailing-comma array and its comma-free
      // twin compare unequal and defeating the equal-sizes check below.
      if (hasContent && !arrayContent.trimEnd().endsWith(',')) elemCount++;
      arraySizes.set(name, elemCount);
    }
  }

  // If we found 2+ arrays with the same size, it's likely a false positive
  if (arraySizes.size >= 2) {
    const sizes = [...arraySizes.values()];
    if (sizes.every((s) => s === sizes[0])) {
      const names = [...arraySizes.keys()].join(', ');
      return `arrays ${names} both have ${sizes[0]} elements — no out-of-bounds`;
    }
  }

  // Also check: if the loop references arr.length and the array size matches
  if (arraySizes.size === 1) {
    const [name, size] = [...arraySizes.entries()][0];
    // Check if the symbol code iterates with `i < NAME.length` pattern
    const symbolCode = lines.slice(lineStart - 1, lineEnd).join('\n');
    if (symbolCode.includes(`${name}.length`)) {
      // Verify no +1 or off-by-one in the loop condition
      const loopMatch = symbolCode.match(new RegExp(`i\\s*<\\s*${name}\\.length`));
      if (loopMatch) {
        return `loop uses ${name}.length (${size}) — indices 0..${size - 1} are valid`;
      }
    }
  }

  return null;
}

/**
 * Check if a JSDoc block (> 20 chars) exists in the lines immediately before
 * the symbol's start line.
 */
export function hasJsDocBefore(content: string, symbolLineStart: number): boolean {
  const lines = content.split('\n');
  const startIdx = Math.max(0, symbolLineStart - 2); // 0-indexed, line directly above the symbol

  // Walk up past blank lines and decorators (which legitimately sit between a
  // JSDoc block and the symbol it documents) to the first meaningful line.
  let i = startIdx;
  while (i >= 0) {
    const line = lines[i]?.trim() ?? '';
    if (line === '' || line.startsWith('@')) { i--; continue; }
    break;
  }
  if (i < 0) return false;

  // That line MUST close a JSDoc block, otherwise the symbol is not directly
  // preceded by one — a JSDoc belonging to an earlier symbol in the window must
  // not count it as documented (the old forward scan did, a false positive).
  const closing = lines[i]!.trim();
  if (!closing.endsWith('*/')) return false;

  // Single-line JSDoc: /** ... */
  if (closing.startsWith('/**')) {
    return closing.length > JSDOC_MIN_LENGTH;
  }

  // Multi-line: accumulate upward to the opening `/**` (bounded to 30 lines).
  let blockContent = closing;
  const lowerBound = Math.max(0, i - 30);
  for (let j = i - 1; j >= lowerBound; j--) {
    const l = lines[j]?.trim() ?? '';
    blockContent = l + blockContent;
    if (l.startsWith('/**')) {
      return blockContent.length > JSDOC_MIN_LENGTH;
    }
    // A non-comment, non-blank line before reaching `/**` means this is not a
    // JSDoc block (e.g. a line comment or stray `*/`).
    if (l !== '' && !l.startsWith('*')) return false;
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

