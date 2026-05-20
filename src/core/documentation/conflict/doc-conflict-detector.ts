// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger } from '../../../utils/logger.js';
import { conversationsDir } from '../../../utils/run-layout.js';
import { isFatalAuthError } from '../../../utils/errors.js';
import { resolveDocMode } from '../../run/index.js';
import {
  loadDocConflicts,
  saveDocConflicts,
  hashCodeAnchor,
  verifyAnchorHash,
} from './doc-conflict-store.js';
import { buildCodeSurfaceSummary } from './doc-coherence-3way.js';
import {
  buildPairDetectionUserMessage,
  DETECTION_SYSTEM_PROMPT,
  DetectionResponseSchema,
  type DetectedConflictItem,
} from './doc-conflict-llm.js';
import {
  dedupePairs,
  batchPairs,
  storePairMatcher,
  type DocPairMatcher,
} from './doc-conflict-pairing.js';
import { runSingleTurnQuery } from '../../evaluation/index.js';
import { type TransportRouter, type LlmResponse } from '../../transports/index.js';
import type { VectorStore } from '../../../rag/vector-store.js';
import type { DocConflict, DocConflictsLock, ArbitrationSignals, Presumption } from '../../../schemas/doc-conflict.js';
import type { Config } from '../../../schemas/config.js';
import type { Task } from '../../../schemas/task.js';

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
  /** doc 15 PR 1: aggregated LLM cost of the new-conflict detection
   *  batches. Present only when the LLM actually ran (absent for
   *  off/lite/no-router/no-batch, exactly as before). The caller folds
   *  this into the run-metrics rollup. */
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
  /** Absolute path to the current run directory — used to dump the LLM
   *  conversation transcript per batch into `<runDir>/conversations/`
   *  for debugging and audit. When omitted, the agentic call still
   *  runs but no transcript is persisted. */
  runDir?: string;
  /** doc 15 PR 1: invoked with each per-batch LLM response so the caller
   *  can fold the detection cost into the run rollup. Optional and
   *  side-effect-only: omitting it is identical to the pre-PR-1 behaviour
   *  (the cost was on the response and discarded). */
  onLlmResponse?: (r: LlmResponse) => void;
  /** doc 16 PR 2b: the already-populated RAG vector store. When present
   *  (real runs), the pair matcher reuses it to find similar internal
   *  sections without re-embedding them. */
  vectorStore?: VectorStore;
  /** doc 16 PR 2b: inject a deterministic pair matcher. Tests pass a stub
   *  so no real embedding/LLM call happens; production leaves it unset and
   *  the matcher is derived from `vectorStore` (or in-memory fallback). */
  pairMatcher?: DocPairMatcher;
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
  } catch (err) {
    // doc 16 PR 2 (doc-15-aligned): a detected conflict dropped here used to
    // vanish silently — the same invisible-miss class D2 is about. Log it.
    log.warn({ file: item.file, err: err instanceof Error ? err.message : String(err) },
      'doc-conflict-detection: dropping conflict — code file unreadable at anchor');
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
  const { projectRoot, config, tasks, router, abortController } = opts;

  if (!router) {
    log.info('doc-conflict-detection: no router available — skipping LLM detection');
    return [];
  }

  const codeSurface = buildCodeSurfaceSummary(tasks);

  // Resolve model: prefer agents.scaffolding, fallback to models.quality.
  const model = config.agents.scaffolding ?? config.models.quality;
  if (!model) {
    log.warn('doc-conflict-detection: no scaffolding/quality model configured — skipping LLM detection');
    return [];
  }

  // doc 16 PR 2b: cosine-match reference↔internal doc-sections using the
  // vectors already persisted in the RAG store and the full passage text
  // already in the doc chunk cache (no re-embed, no re-chunk), then
  // LLM-verify only the suspect pairs in small calls. Replaces the
  // monolithic whole-corpus call that always hit DETECTION_TIMEOUT_MS.
  const matcher: DocPairMatcher | undefined =
    opts.pairMatcher ??
    (opts.vectorStore ? storePairMatcher(opts.vectorStore, projectRoot) : undefined);
  if (!matcher) {
    log.info('doc-conflict-detection: no vector store available — skipping pair detection');
    return [];
  }

  const pairs = dedupePairs(await matcher());
  if (pairs.length === 0) {
    log.info('doc-conflict-detection: no similar passage pairs above threshold — no conflicts');
    return [];
  }

  // Snapshot of known ids — grown per batch to dedupe across batches.
  const seenIds = new Set(existingIds);
  const knownDescriptions = Array.from(seenIds).map(id => `id=${id}`);
  const allowedReferencePaths = new Set(pairs.map(p => p.ref.filePath));
  const newConflicts: DocConflict[] = [];

  const batches = batchPairs(pairs, 10);
  log.info({ pairs: pairs.length, batches: batches.length },
    'doc-conflict-detection: verifying matched passage pairs');

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const userMessage = buildPairDetectionUserMessage({
      pairs: batches[batchIdx],
      codeSurface,
      ...(knownDescriptions.length > 0 ? { knownConflictDescriptions: knownDescriptions } : {}),
    });

    // doc 16 PR 2c: the single-turn query path (the same `transport.query`
    // every axis uses successfully each run), NOT `router.agenticQuery`.
    // The bench proved the Claude Code agentic subprocess returns zero
    // output within 120s regardless of prompt size (a 23KB pair prompt
    // aborted identically to the 100KB/123KB monolith). Detection is a
    // no-tool structured-JSON extraction — it never needed the agentic
    // path. The timeout is now a genuine safety net, not the failure mode.
    const ac = abortController ?? new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(), DETECTION_TIMEOUT_MS);

    let parsed;
    try {
      const result = await runSingleTurnQuery(
        {
          systemPrompt: DETECTION_SYSTEM_PROMPT,
          userMessage,
          model,
          projectRoot,
          abortController: ac,
          composer: 'doc-conflict',
          primitive: 'doc-conflict-detection',
          callId: `pairs-${batchIdx + 1}`,
          ...(opts.router ? { router: opts.router } : {}),
          ...(opts.runDir
            ? { conversationDir: conversationsDir(opts.runDir) }
            : {}),
        },
        DetectionResponseSchema,
      );
      parsed = result.data; // already schema-validated by runSingleTurnQuery
      // doc 15 PR 1: fold the per-call cost into the run rollup. The
      // accumulator reads only these numeric fields.
      opts.onLlmResponse?.({
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
      } as LlmResponse);
    } catch (err) {
      // A provider-auth failure is run-fatal: propagate.
      if (isFatalAuthError(err)) throw err;
      log.warn({ err: err instanceof Error ? err.message : String(err), batchIdx },
        'doc-conflict-detection: single-turn query failed — skipping batch');
      continue;
    } finally {
      clearTimeout(timeoutHandle);
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
  // doc 15 PR 1: fold the per-batch detection cost (previously discarded)
  // so the caller can record it into the run-metrics rollup.
  const existingIds = new Set(entries.map(e => e.id));
  const dcCost = {
    costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, calls: 0,
  };
  const newConflicts = await detectNewConflictsViaLlm(
    {
      ...opts,
      onLlmResponse: (r) => {
        dcCost.costUsd += r.costUsd;
        dcCost.durationMs += r.durationMs;
        dcCost.inputTokens += r.inputTokens;
        dcCost.outputTokens += r.outputTokens;
        dcCost.cacheReadTokens += r.cacheReadTokens;
        dcCost.cacheCreationTokens += r.cacheCreationTokens;
        dcCost.calls += 1;
      },
    },
    existingIds,
  );
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
    // doc 15 PR 1: attach cost only when the LLM actually ran (>=1 batch),
    // so off/lite/no-router/no-batch yield no cost entry — identical to
    // pre-PR-1 (where cost was simply never recorded).
    ...(dcCost.calls > 0 ? { cost: dcCost } : {}),
  };

  log.info({
    phase: 'doc-conflict-detection',
    ...summary,
  }, 'doc-conflict-detection complete');

  return summary;
}
