// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import { resolveDocMode } from './run-config.js';
import {
  loadDocConflicts,
  saveDocConflicts,
  hashCodeAnchor,
  verifyAnchorHash,
} from './doc-conflict-store.js';
import { resolveReferenceDocs } from './reference-docs-resolver.js';
import { buildCodeSurfaceSummary } from './doc-coherence-3way.js';
import {
  buildDetectionUserMessage,
  collectInternalDocFragments,
  DETECTION_SYSTEM_PROMPT,
  DetectionResponseSchema,
  parseDetectionResponse,
  type DetectedConflictItem,
} from './doc-conflict-llm.js';
import { EVALUATOR_TEMPERATURE, type TransportRouter } from './transports/index.js';
import { countTokens } from './estimator.js';
import type { DocConflict, DocConflictsLock, ArbitrationSignals, Presumption } from '../schemas/doc-conflict.js';
import type { Config } from '../schemas/config.js';
import type { Task } from '../schemas/task.js';

/** Token budget for a single detection batch. Below the Sonnet 200k window
 * with margin for system prompt + output. When the assembled prompt exceeds
 * this, the detector batches the internal fragments. */
const DETECTION_PROMPT_TOKEN_BUDGET = 120_000;

/** Hard timeout on the detection LLM call. Above this the run continues
 * with no new conflicts rather than hanging. */
const DETECTION_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DetectionSummary {
  newConflicts: number;
  applied: number;
  stale: number;
  pending: number;
}

export interface DocConflictDetectionOpts {
  projectRoot: string;
  config: Config;
  tasks: Task[];
  fragmentsDir: string;
  /** Optional transport router for LLM-driven new conflict detection.
   *  When omitted, the detector still runs stale verification and verdict
   *  application but skips new-conflict detection (used in tests). */
  router?: TransportRouter;
  /** Optional abort controller (used for graceful shutdown during agentic call). */
  abortController?: AbortController;
}

// ---------------------------------------------------------------------------
// Presumption derivation — Story 55.4 AC3
// ---------------------------------------------------------------------------

/**
 * Derive the presumption from arbitration signals.
 *
 * Rule: if code was touched after doc → doc-stale; if doc after code →
 * code-drift; else unknown. When either timestamp is missing (untracked
 * file, git unavailable, etc.) the rule cannot fire — returns `unknown`
 * rather than guessing.
 */
export function derivePresumption(signals: ArbitrationSignals): Presumption {
  if (!signals.doc_last_touched || !signals.code_last_touched) {
    return 'unknown';
  }

  const docTime = new Date(signals.doc_last_touched).getTime();
  const codeTime = new Date(signals.code_last_touched).getTime();
  if (Number.isNaN(docTime) || Number.isNaN(codeTime)) {
    return 'unknown';
  }

  if (codeTime > docTime) return 'doc-stale';
  if (docTime > codeTime) return 'code-drift';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Stale entry detection — Story 55.4 AC (FR4b)
// ---------------------------------------------------------------------------

/**
 * For each entry, verify the code_hash against current file contents.
 * If the hash doesn't match (or file is missing), mark as stale-by-codechange
 * and revert verdict to pending.
 */
export function markStaleEntries(
  entries: DocConflict[],
  fileContents: Map<string, string>,
): { entries: DocConflict[]; staleCount: number } {
  let staleCount = 0;

  const updated = entries.map((entry) => {
    const content = fileContents.get(entry.anchor.file);

    // File deleted or not available — mark stale
    if (content === undefined) {
      staleCount++;
      return {
        ...entry,
        status: 'stale-by-codechange' as const,
        verdict: 'pending' as const,
        verdict_note: `[auto] code changed or file removed — ${new Date().toISOString()}`,
      };
    }

    const verification = verifyAnchorHash(entry, content);
    if (verification === 'stale') {
      staleCount++;
      return {
        ...entry,
        status: 'stale-by-codechange' as const,
        verdict: 'pending' as const,
        verdict_note: `[auto] code changed — hash mismatch at ${new Date().toISOString()}`,
      };
    }

    return entry;
  });

  return { entries: updated, staleCount };
}

// ---------------------------------------------------------------------------
// Apply resolved verdicts — Story 55.4 AC (FR4c)
// ---------------------------------------------------------------------------

/**
 * For entries with a non-pending verdict and active status, apply the verdict:
 * - doc-wins / code-wins → status: applied
 * - skip → status: skipped
 */
export function applyResolvedVerdicts(
  entries: DocConflict[],
): { entries: DocConflict[]; appliedCount: number } {
  let appliedCount = 0;

  const updated = entries.map((entry) => {
    // Only apply verdicts on active entries that have a non-pending verdict
    if (entry.verdict === 'pending') return entry;
    if (entry.status === 'applied' || entry.status === 'skipped') return entry;
    if (entry.status === 'stale-by-codechange') return entry;

    appliedCount++;

    if (entry.verdict === 'skip') {
      return { ...entry, status: 'skipped' as const };
    }

    return { ...entry, status: 'applied' as const };
  });

  return { entries: updated, appliedCount };
}

// ---------------------------------------------------------------------------
// Git timestamp extraction — Story 55.4 AC3
// ---------------------------------------------------------------------------

/**
 * Get the last commit timestamp (ISO 8601) for a file via git log.
 * Returns `undefined` if git is unavailable, the file is untracked, or any
 * other error occurs. Callers should treat `undefined` as "unknown" — never
 * substitute `new Date()` (that would falsely claim the file was touched
 * "now" and mislead the presumption heuristic).
 */
export function getGitTimestamp(projectRoot: string, filePath: string): string | undefined {
  try {
    const result = execFileSync('git', ['log', '-1', '--format=%cI', '--', filePath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Test coverage heuristic — Story 55.4 AC3
// ---------------------------------------------------------------------------

/**
 * Check if a symbol is covered by tests via grep heuristic.
 * Searches for the symbol name in files matching *.test.* or *_test.*.
 */
export function checkTestCoverage(projectRoot: string, symbol: string | undefined): boolean | undefined {
  if (!symbol) return undefined;

  try {
    // Use git grep for efficiency (only searches tracked files)
    const result = execFileSync('git', ['grep', '-l', symbol, '--', '*.test.*', '*_test.*', '*.spec.*'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return result.length > 0;
  } catch {
    // git grep returns exit code 1 when no matches found
    return false;
  }
}

// ---------------------------------------------------------------------------
// Conflict ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable ID for a conflict based on anchor location.
 */
export function generateConflictId(anchor: { file: string; symbol?: string; line_range?: [number, number] }): string {
  const hash = createHash('sha256');
  hash.update(anchor.file);
  if (anchor.symbol) hash.update(`:${anchor.symbol}`);
  if (anchor.line_range) hash.update(`:${anchor.line_range[0]}-${anchor.line_range[1]}`);
  return hash.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Convert a raw LLM-detected item into a persistent DocConflict — Story 55.10
// ---------------------------------------------------------------------------

/** Max file size we'll read when computing a hash, to avoid blocking the
 * event loop on generated lockfiles / snapshots. Conflicts on such files
 * are dropped explicitly rather than freezing the detector. */
const MAX_ANCHOR_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Resolve the line range of an LLM-reported symbol via the scanner's task
 * output. Provides a symbol-grained hash anchor when the LLM gave a symbol
 * name but no explicit line range (FR4 Story 55.3 AC3).
 *
 * Returns `undefined` when the symbol is not found in the scanner output —
 * caller falls back to the file-level hash.
 */
function resolveSymbolLineRange(
  tasks: Task[],
  file: string,
  symbol: string,
): [number, number] | undefined {
  const task = tasks.find(t => t.file === file);
  if (!task) return undefined;
  const sym = task.symbols.find(s => s.name === symbol);
  if (!sym) return undefined;
  return [sym.line_start, sym.line_end];
}

/**
 * Enrich a raw LLM detection result with persistent metadata: code hash,
 * arbitration signals, stable id, timestamp. Returns null when the anchor
 * cannot be resolved (file missing or unreadable, file too large) — these
 * cases are silently skipped to keep the detector resilient on partial
 * fixtures.
 */
export function enrichDetectedConflict(
  projectRoot: string,
  item: DetectedConflictItem,
  opts: { tasks?: Task[]; allowedReferencePaths?: Set<string> } = {},
): DocConflict | null {
  const log = getLogger();

  // Validate reference_path against the configured allow-list when provided
  // — prevents the LLM from anchoring to paths outside reference.paths and
  // protects against hallucinated path traversal.
  if (opts.allowedReferencePaths && !opts.allowedReferencePaths.has(item.reference_path)) {
    log.warn({ file: item.file, reference_path: item.reference_path },
      'doc-conflict-detection: dropping conflict — reference_path not in documentation.reference.paths');
    return null;
  }

  const codePath = join(projectRoot, item.file);

  // File-size guard: synchronous reads on multi-MB files block the event loop.
  let codeContent: string;
  try {
    const stat = statSync(codePath);
    if (stat.size > MAX_ANCHOR_FILE_BYTES) {
      log.warn({ file: item.file, size: stat.size },
        'doc-conflict-detection: dropping conflict — file exceeds anchor size limit');
      return null;
    }
    codeContent = readFileSync(codePath, 'utf-8');
  } catch {
    return null;
  }

  // Determine line range — prefer LLM-provided, otherwise look up symbol in tasks.
  let lineRange: [number, number] | undefined =
    item.line_start && item.line_end ? [item.line_start, item.line_end] : undefined;
  if (!lineRange && item.symbol && opts.tasks) {
    lineRange = resolveSymbolLineRange(opts.tasks, item.file, item.symbol);
  }

  const codeHash = hashCodeAnchor(item.file, item.symbol, lineRange, codeContent);

  const anchor = {
    file: item.file,
    ...(item.symbol ? { symbol: item.symbol } : {}),
    ...(lineRange ? { line_range: lineRange } : {}),
    code_hash: codeHash,
  };

  const id = generateConflictId({
    file: item.file,
    symbol: item.symbol,
    line_range: lineRange,
  });

  const docTouched = getGitTimestamp(projectRoot, item.reference_path);
  const codeTouched = getGitTimestamp(projectRoot, item.file);
  const testCoverage = checkTestCoverage(projectRoot, item.symbol);

  const signals: ArbitrationSignals = {
    ...(docTouched ? { doc_last_touched: docTouched } : {}),
    ...(codeTouched ? { code_last_touched: codeTouched } : {}),
    ...(testCoverage !== undefined ? { test_covers_current_behavior: testCoverage } : {}),
    presumption: derivePresumption({
      ...(docTouched ? { doc_last_touched: docTouched } : {}),
      ...(codeTouched ? { code_last_touched: codeTouched } : {}),
      presumption: 'unknown',
    }),
  };

  const referenceLineRange: [number, number] | undefined =
    item.reference_line_start && item.reference_line_end
      ? [item.reference_line_start, item.reference_line_end]
      : undefined;

  return {
    id,
    detected_at: new Date().toISOString(),
    anchor,
    reference_excerpt: {
      path: item.reference_path,
      ...(referenceLineRange ? { line_range: referenceLineRange } : {}),
      text: item.reference_text,
    },
    code_summary: item.code_summary,
    signals,
    verdict: 'pending',
    status: 'active',
  };
}

// ---------------------------------------------------------------------------
// Batching helper — Story 55.10 NFR3
// ---------------------------------------------------------------------------

/**
 * Split internal-doc fragments into batches such that each assembled prompt
 * stays under the detection token budget. Reference docs and code surface
 * are constant overhead per batch — fragments are the variable part that
 * grows with project size.
 *
 * The fixed overhead (reference + surface + scaffolding) is computed once;
 * each fragment is added to the current batch while it still fits, then
 * starts a new batch. A single oversized fragment ends up alone in its
 * batch (acceptable — the model will simply truncate or fail validation,
 * caller handles either case).
 */
export function batchFragmentsByTokenBudget(
  fragments: Array<{ relPath: string; content: string }>,
  fixedOverheadTokens: number,
  budget: number = DETECTION_PROMPT_TOKEN_BUDGET,
): Array<Array<{ relPath: string; content: string }>> {
  if (fragments.length === 0) return [[]];

  const batches: Array<Array<{ relPath: string; content: string }>> = [];
  let current: Array<{ relPath: string; content: string }> = [];
  let currentTokens = fixedOverheadTokens;

  for (const f of fragments) {
    const fragTokens = countTokens(f.relPath) + countTokens(f.content) + 16; // small markup overhead
    if (current.length > 0 && currentTokens + fragTokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = fixedOverheadTokens;
    }
    current.push(f);
    currentTokens += fragTokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ---------------------------------------------------------------------------
// Detect new conflicts via LLM — Story 55.10
// ---------------------------------------------------------------------------

/**
 * Call the LLM with a 3-way prompt (reference / internal / code surface)
 * to detect new conflicts not yet in the lock. Returns the list of
 * enriched DocConflict entries ready to merge.
 *
 * Errors (LLM unavailable, invalid JSON, timeout, oversized prompts) are
 * logged as warnings and the function returns whatever conflicts it did
 * successfully detect — the run continues with at-least-as-much state as
 * before, never crashes.
 *
 * The {@link existingIds} set passed by the caller is read-only — this
 * function does not mutate it. Internal dedup tracking lives in a local
 * copy.
 */
export async function detectNewConflictsViaLlm(
  opts: DocConflictDetectionOpts,
  existingIds: ReadonlySet<string>,
): Promise<DocConflict[]> {
  const log = getLogger();
  const { projectRoot, config, tasks, fragmentsDir, router, abortController } = opts;

  if (!router) {
    log.info('doc-conflict-detection: no router available — skipping LLM detection');
    return [];
  }

  // Resolve inputs
  const referenceDocs = await resolveReferenceDocs(projectRoot, config);
  const internalFragments = collectInternalDocFragments(fragmentsDir);
  const codeSurface = buildCodeSurfaceSummary(tasks);

  if (referenceDocs.length === 0 && internalFragments.length === 0) {
    log.info('doc-conflict-detection: no reference docs and no internal fragments — nothing to compare');
    return [];
  }

  // Resolve model: prefer agents.scaffolding, fallback to models.quality.
  // Note: scaffolding is the closest existing model slot for non-axis doc
  // work; a future epic may introduce agents.doc_conflict explicitly.
  const model = config.agents.scaffolding ?? config.models.quality;
  if (!model) {
    log.warn('doc-conflict-detection: no scaffolding/quality model configured — skipping LLM detection');
    return [];
  }

  // Compute fixed overhead (reference + code surface + system prompt) once
  // so batching only varies on internal fragments.
  const overheadMessage = buildDetectionUserMessage({
    referenceDocs,
    internalFragments: [],
    codeSurface,
  });
  const fixedOverheadTokens = countTokens(overheadMessage) + countTokens(DETECTION_SYSTEM_PROMPT);

  // Snapshot of known ids — grown internally per batch to dedupe across batches.
  // We intentionally clone so the caller's set is never mutated.
  const seenIds = new Set(existingIds);
  const knownDescriptions = Array.from(seenIds).map(id => `id=${id}`);

  const batches = batchFragmentsByTokenBudget(internalFragments, fixedOverheadTokens);
  if (batches.length > 1) {
    log.info({ batchCount: batches.length, fragmentCount: internalFragments.length },
      'doc-conflict-detection: token budget exceeded — splitting into batches');
  }

  // Build allow-list for reference_path validation.
  const allowedReferencePaths = new Set(referenceDocs.map(d => d.path));

  const newConflicts: DocConflict[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    const userMessage = buildDetectionUserMessage({
      referenceDocs,
      internalFragments: batch,
      codeSurface,
      ...(knownDescriptions.length > 0 ? { knownConflictDescriptions: knownDescriptions } : {}),
    });

    // Per-batch abort wired to a hard timeout — protects against stuck LLM.
    const ac = abortController ?? new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), DETECTION_TIMEOUT_MS);

    let responseText: string;
    try {
      const response = await router.agenticQuery({
        systemPrompt: DETECTION_SYSTEM_PROMPT,
        userMessage,
        model,
        projectRoot,
        abortController: ac,
        allowedTools: [],
        config,
        responseSchema: DetectionResponseSchema,
        temperature: EVALUATOR_TEMPERATURE,
        attempt: 1,
      });
      responseText = response.text;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), batchIdx },
        'doc-conflict-detection: LLM call failed — skipping batch');
      continue;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const parsed = parseDetectionResponse(responseText);
    if (!parsed) {
      log.warn({ batchIdx }, 'doc-conflict-detection: failed to parse LLM response — skipping batch');
      continue;
    }

    // Enrich + dedupe by id, validate reference_path against allow-list.
    for (const item of parsed.conflicts) {
      const enriched = enrichDetectedConflict(projectRoot, item, { tasks, allowedReferencePaths });
      if (!enriched) continue;
      if (seenIds.has(enriched.id)) continue;
      seenIds.add(enriched.id);
      knownDescriptions.push(`id=${enriched.id}`);
      newConflicts.push(enriched);
    }
  }

  return newConflicts;
}

// ---------------------------------------------------------------------------
// Main detection entry point — Story 55.4 AC1
// ---------------------------------------------------------------------------

/**
 * Run doc-conflict detection.
 *
 * 1. Load existing lock (or create empty)
 * 2. Verify code_hash for non-pending entries → mark stale
 * 3. Apply resolved verdicts (doc-wins, code-wins, skip)
 * 4. Write updated lock
 * 5. Return summary for logger and run-metrics
 *
 * Short-circuits for lite and off modes (no-op with log info).
 */
export async function runDocConflictDetection(
  opts: DocConflictDetectionOpts,
): Promise<DetectionSummary> {
  const log = getLogger();
  const { projectRoot, config } = opts;
  const mode = resolveDocMode(config);

  // AC6: Short-circuit for lite and off modes
  if (mode === 'off') {
    log.info('doc-conflict-detection: mode=off — skipping');
    return { newConflicts: 0, applied: 0, stale: 0, pending: 0 };
  }

  if (mode === 'lite') {
    log.info('doc-conflict-detection: mode=lite — skipping (no conflicts in lite mode)');
    return { newConflicts: 0, applied: 0, stale: 0, pending: 0 };
  }

  // Load existing lock
  let lock = loadDocConflicts(projectRoot);
  if (!lock) {
    lock = {
      version: 1,
      generated_at: new Date().toISOString(),
      entries: [],
    };
  }

  // Build file contents map for hash verification
  const fileContents = new Map<string, string>();
  for (const entry of lock.entries) {
    const filePath = join(projectRoot, entry.anchor.file);
    if (existsSync(filePath) && !fileContents.has(entry.anchor.file)) {
      try {
        fileContents.set(entry.anchor.file, readFileSync(filePath, 'utf-8'));
      } catch {
        // File unreadable — will be marked stale
      }
    }
  }

  // Step 1: Mark stale entries (FR4b)
  const staleResult = markStaleEntries(lock.entries, fileContents);
  let entries = staleResult.entries;

  // Step 2: Apply resolved verdicts (FR4c)
  const applyResult = applyResolvedVerdicts(entries);
  entries = applyResult.entries;

  // Step 3: Detect new conflicts via LLM (Story 55.10, FR4d-e)
  const existingIds = new Set(entries.map(e => e.id));
  const newConflicts = await detectNewConflictsViaLlm(opts, existingIds);
  entries = [...entries, ...newConflicts];

  // Step 4: Write updated lock
  const updatedLock: DocConflictsLock = {
    version: 1,
    generated_at: new Date().toISOString(),
    entries,
  };
  saveDocConflicts(projectRoot, updatedLock);

  const pendingCount = entries.filter(e => e.verdict === 'pending').length;

  const summary: DetectionSummary = {
    newConflicts: newConflicts.length,
    applied: applyResult.appliedCount,
    stale: staleResult.staleCount,
    pending: pendingCount,
  };

  log.info({
    phase: 'doc-conflict-detection',
    ...summary,
  }, 'doc-conflict-detection complete');

  return summary;
}
