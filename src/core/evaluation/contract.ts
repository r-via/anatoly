// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * The evaluation context's **published language** (doc 12 §4, doc 13 PR 7b).
 *
 * The type/interface half of the former `axis-evaluator.ts`, split out so
 * cross-context consumers (`documentation/resolution/docs-resolver`,
 * `reporting/reporter`, `run/run-config`, and the §5 edges generally)
 * depend on the contract, never the implementation. The implementation
 * lives in `./evaluator.js`, which imports these types. Every declaration
 * below is byte-identical to its pre-split form; only the file split and
 * the import list (pruned to what the types reference) changed.
 */

import type { Task } from '../../schemas/task.js';
import type { Config } from '../../schemas/config.js';
import type { UsageGraph } from '../scanning/index.js';
import type { FileDependencyContext } from '../scanning/index.js';
import type { SimilarityResult } from '../../rag/types.js';
import type { Action, DocDivergence } from '../../schemas/review.js';
import type { UserInstructions } from '../../utils/user-instructions.js';
import type { ReferenceDoc } from '../documentation/index.js';
import type { TransportRouter } from '../transports/index.js';

// ---------------------------------------------------------------------------
// Pre-resolved RAG types (moved from prompt-builder.ts)
// ---------------------------------------------------------------------------

/** A single pre-resolved RAG lookup for one symbol, mapping it to similarity results from the vector index. */
export interface PreResolvedRagEntry {
  symbolName: string;
  lineStart: number;
  lineEnd: number;
  /** null means the function was not found in the index */
  results: SimilarityResult[] | null;
}

export type PreResolvedRag = PreResolvedRagEntry[];

/** Interface of one project function imported by the file under review:
 *  its name, the source file it lives in, its first-line signature, and the
 *  RAG behavioral summary. Resolved from the reverse usage graph + RAG cards
 *  so the correction axis can ground remediations in real inputs/outputs. */
export interface ImportedSymbolInterface {
  name: string;
  filePath: string;
  signature: string;
  summary?: string;
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type AxisId =
  | 'utility'
  | 'duplication'
  | 'correction'
  | 'overengineering'
  | 'tests'
  | 'best_practices'
  | 'documentation';

/** Input bundle passed to every axis evaluator's `evaluate()` method. */
export interface AxisContext {
  task: Task;
  fileContent: string;
  config: Config;
  projectRoot: string;
  usageGraph?: UsageGraph;
  preResolvedRag?: PreResolvedRag;
  fileDeps?: FileDependencyContext;
  projectTree?: string;
  /** Content of the associated test file (e.g. foo.test.ts for foo.ts), if it exists */
  testFileContent?: string;
  /** Relative path of the resolved test file (e.g. "src/foo.test.ts") */
  testFileName?: string;
  /** ASCII tree of docs/ directory (null if no docs dir) */
  docsTree?: string | null;
  /** Relevant documentation pages resolved for the current file */
  relevantDocs?: RelevantDoc[];
  /** Human-authored reference docs, retrieved per-file via RAG in lite mode (README, specs, docs/). */
  referenceDocs?: ReferenceDoc[];
  /** Doc-wins arbitrated fragments promoted to authoritative status. Story 55.7. */
  arbitratedFragments?: import('./axes/reference-docs-context.js').ArbitratedFragment[];
  /** Full path to conversations/ dir in the run dir (undefined = no dump) */
  conversationDir?: string;
  /** Interfaces of project functions this file imports (name + signature +
   *  behavioral summary), resolved from the reverse usage graph and RAG cards.
   *  Lets the correction axis ground remediations in the real inputs/outputs of
   *  imported symbols (rules 15/16). Absent in RAG-off mode. */
  importedInterfaces?: ImportedSymbolInterface[];
  /** doc 19 PR 3 — per-call disambiguator (e.g. file slug "src-cli"). Becomes
   *  the `callId` segment of the harness-assigned dump slug
   *  `{phase}__{composer}__{primitive}__{callId}__{attempt}.md`. */
  callId?: string;
  /** Mode-aware transport router — handles concurrency, circuit breaking, and transport selection */
  router?: TransportRouter;
  /** User instructions from ANATOLY.md — loaded once per run, passed to each evaluator */
  userInstructions?: UserInstructions;
}

export interface RelevantDoc {
  path: string;
  content: string;
  /** Origin of the doc: 'project' (docs/) or 'internal' (.anatoly/docs/). */
  source?: 'project' | 'internal';
}

/** Per-symbol output record produced by an axis evaluator. */
export interface AxisSymbolResult {
  name: string;
  line_start: number;
  line_end: number;
  /** The axis-specific value (e.g. "USED", "DEAD", "OK", "NEEDS_FIX") */
  value: string;
  confidence: number;
  detail: string;
  /** For duplication axis only */
  duplicate_target?: { file: string; symbol: string; similarity: string };
  /**
   * One entry per distinct defect when a symbol carries several
   * independent issues (typically on the `correction` axis: a function
   * with both a wrong-sign computation and a Math.ceil rounding bug).
   * Empty/absent means "single defect, see `detail`" — backward-
   * compatible with axes that emit one finding per symbol.
   */
  findings?: Array<{ line_start: number; line_end: number; detail: string }>;
}

/** Complete result of one axis evaluation run, including per-symbol verdicts, actions, and cost metrics. */
export interface AxisResult {
  axisId: AxisId;
  symbols: AxisSymbolResult[];
  /** File-level results (optional, e.g. unused_imports) */
  fileLevel?: Partial<{ unused_imports: string[]; circular_dependencies: string[]; general_notes: string }>;
  actions: Action[];
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  transcript: string;
  /** Reference-vs-code divergences detected by the LLM (Story 54.9 / FR15). */
  doc_divergences?: DocDivergence[];
}

/** Contract implemented by all axis evaluators. `defaultModel` selects haiku (fast) or sonnet (capable). */
export interface AxisEvaluator {
  readonly id: AxisId;
  readonly defaultModel: 'sonnet' | 'haiku';
  evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult>;
}

// ---------------------------------------------------------------------------
// Shared single-turn query types
// ---------------------------------------------------------------------------

/** Parameters for a single-turn LLM query executed via {@link runSingleTurnQuery}. */
export interface SingleTurnQueryParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  projectRoot: string;
  abortController: AbortController;
  /** Full path to conversations/ dir — when set, a conversation dump .md is written per attempt */
  conversationDir?: string;
  /** doc 19 PR 3 — per-call disambiguator added to the ALS scope so the
   *  transport can derive the harness-assigned dump filename via
   *  {@link buildDumpSlug}. Replaces the legacy `conversationPrefix` /
   *  `conversationFileSlug` plumbing. */
  callId?: string;
  /** Mode-aware transport router — handles concurrency, circuit breaking, and transport selection */
  router?: TransportRouter;
  /** User calibration text from ANATOLY.md (pre-resolved for this axis via forAxis()) */
  userInstructions?: string;
  /** Story 56.11 — composer name (e.g. 'axes.correction'); opens an ALS scope so the
   *  llm-calls-sink ledger record carries `composer` for D.4 aggregations. */
  composer?: string;
  /** Story 56.11 — primitive name (e.g. 'axes.correction-pass1'); opens an ALS scope
   *  so the llm-calls-sink ledger record carries `primitive` for D.4 aggregations. */
  primitive?: string;
  /** Per-call wall-clock budget in milliseconds. Each `transport.query()`
   *  attempt is wrapped with this timeout; on expiry the abortController
   *  is aborted and the call rejects with SDK_TIMEOUT. Callers should pass
   *  `config.runtime.timeout_per_call * 1000`. Omitted ⇒ no per-call bound. */
  timeoutMs?: number;
}

export interface SingleTurnQueryResult<T> {
  data: T;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  transcript: string;
}

// The execution-unit SPI (ExecutionUnit / HarnessCtx) moved to its own
// zero-dependency context `core/harness/` in doc 14 PR 3a (see
// harness/contract.ts for the rationale: a single harness every agent flows
// through cannot live in `evaluation/` without an evaluation<->documentation
// cycle). Import it from `../harness/index.js`.
