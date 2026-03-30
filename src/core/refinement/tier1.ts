// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
const FIXTURE_PATTERNS = ['__gold-set__', '__fixtures__'];
const GENERATED_MARKERS = ['@generated', 'DO NOT EDIT', 'AUTO-GENERATED', 'BEGIN GENERATED', 'auto-generated'];
const MISSING_IMPORT_PATTERNS = /\b(?:missing|undefined|not (?:defined|found|exported)|does not exist|cannot find)\b.*\b(?:function|import|module|export|method|symbol)\b|\b(?:function|import|module|export|method|symbol)\b.*\b(?:missing|undefined|not (?:defined|found|exported)|does not exist|cannot find)\b/i;
const BOUNDS_PATTERNS = /\b(?:out[- ]of[- ]bounds|array.*(?:has|only|contains)\s+\d+.*(?:but|while|however).*\d+|index\s+\d+.*(?:but|while).*length\s+\d+)\b/i;

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
  const stats: Tier1Stats = { resolved: 0, confirmed: 0, breakdown: { deadToUsed: 0, duplicateToUnique: 0, overToLean: 0, undocToDoc: 0, fixtureSkipped: 0, correctionImportResolved: 0, correctionBoundsResolved: 0, correctionGeneratedDowngraded: 0 } };
  const isFixture = FIXTURE_PATTERNS.some((p) => review.file.includes(p));

  // Detect generated files: check for markers in file content
  let fileContent = ctx.fileContents.get(review.file);
  if (!fileContent && ctx.projectRoot) {
    try {
      fileContent = readFileSync(resolve(ctx.projectRoot, review.file), 'utf-8');
      ctx.fileContents.set(review.file, fileContent);
    } catch { /* file may have been deleted */ }
  }
  const isGenerated = fileContent ? GENERATED_MARKERS.some((m) => fileContent!.includes(m)) : false;

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

    // --- Correction: missing import → OK when import resolves on disk ---
    if ((s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') && MISSING_IMPORT_PATTERNS.test(s.detail)) {
      if (fileContent && ctx.projectRoot) {
        const resolved = verifyCorrectionImport(s.detail, fileContent, review.file, ctx.projectRoot);
        if (resolved) {
          s.correction = 'OK';
          s.confidence = 95;
          s.detail = `Auto-resolved: import verified on disk (${resolved})`;
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
          s.correction = 'OK';
          s.confidence = 95;
          s.detail = `Auto-resolved: ${match}`;
          stats.resolved++;
          stats.breakdown.correctionBoundsResolved++;
        }
      }
    }

    // --- Correction: generated file → downgrade ERROR to NEEDS_FIX ---
    if (isGenerated && s.correction === 'ERROR') {
      s.correction = 'NEEDS_FIX';
      s.confidence = Math.min(s.confidence, 55);
      s.detail = `Downgraded: generated/auto-generated code | ${s.detail}`;
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
          s.detail = `Auto-resolved: runtime-imported by ${runtimeImporters.length} files`;
          resolved = true;
        } else {
          const typeOnlyImporters = getTypeOnlySymbolUsage(ctx.usageGraph, s.name, review.file);
          if (typeOnlyImporters.length > 0) {
            s.utility = 'USED';
            s.confidence = 95;
            s.detail = `Auto-resolved: type-only imported by ${typeOnlyImporters.length} files`;
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
          s.detail = `Auto-resolved: transitively used by ${transitiveRefs.join(', ')}`;
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
          s.detail = `Auto-resolved: referenced by ${[...intraRefs].join(', ')} in same file`;
          resolved = true;
        }
      }

      if (resolved) {
        stats.resolved++;
        stats.breakdown.deadToUsed++;
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
      // Lazy-load file content if not pre-populated
      let content = ctx.fileContents.get(review.file);
      if (!content && ctx.projectRoot) {
        try {
          content = readFileSync(resolve(ctx.projectRoot, review.file), 'utf-8');
          ctx.fileContents.set(review.file, content);
        } catch { /* file may have been deleted */ }
      }

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
      if (hasContent) elemCount++; // Last element has no trailing comma (or does — either way +1 for content)
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
      // Handle single-line JSDoc: /** @deprecated Use foo instead. */
      if (line.includes('*/')) {
        if (blockContent.length > JSDOC_MIN_LENGTH) return true;
        inBlock = false;
        blockContent = '';
        continue;
      }
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
