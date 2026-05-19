// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Run-layout convention: the single source of truth for the location and
 * naming of every artifact under `<project>/.anatoly/runs/<runId>/`.
 *
 * See `docs/02-Architecture/19-Run-Layout-Convention.md` for the contract.
 *
 * Rules (enforced by `run-layout.test.ts`):
 *
 * 1. Subdirectory names appear here only (`RUN_SUBDIRS`); no other module
 *    inlines `'logs'`, `'reviews'`, `'conversations'`, `'costs'`, `'axes'`,
 *    `'structure-review'`, `'coherence-review'` when composing a run-dir
 *    path.
 * 2. Special filenames (`report.md`, `public_report.md`, `run-status.json`,
 *    `run-config.json`, `run-metrics.json`, `error.log`, `ledger.ndjson`,
 *    `summary.json`, `variance.json`, etc.) appear here only; writers ask
 *    for a path helper.
 * 3. Every helper takes the run directory (`runDir`) as its first arg —
 *    consistent with the existing shape of phase contexts, transports, and
 *    `runUnit` callers that already hold `runDir`. Callers that only have
 *    `projectRoot` + `runId` compose via {@link runPath} first.
 *
 * Writers (`writeFileSync`/`createWriteStream`/...) stay where they are.
 * Only the path string they pass is centralized.
 */

import { join } from 'node:path';
import { toOutputName } from './cache.js';

/**
 * Canonical subdirectory names under `runs/<runId>/`. Single source of
 * truth; referenced by every helper below and by `createRunDir` for the
 * startup `mkdirSync` calls.
 */
export const RUN_SUBDIRS = {
  logs: 'logs',
  reviews: 'reviews',
  conversations: 'conversations',
  costs: 'costs',
  axes: 'axes',
  structureReview: 'structure-review',
  coherenceReview: 'coherence-review',
} as const;

// --------------------------------------------------------------------------
// Subdirectories
// --------------------------------------------------------------------------

export function logsDir(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.logs);
}

export function reviewsDir(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.reviews);
}

export function conversationsDir(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.conversations);
}

export function costsDir(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.costs);
}

export function axesDir(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.axes);
}

export function axisDir(runDir: string, axis: string): string {
  return join(runDir, RUN_SUBDIRS.axes, axis);
}

export function structureReviewDir(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.structureReview);
}

export function coherenceReviewDir(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.coherenceReview);
}

// --------------------------------------------------------------------------
// Top-level files
// --------------------------------------------------------------------------

/** Master internal report (axes index + divergence section). */
export function reportPath(runDir: string): string {
  return join(runDir, 'report.md');
}

/** User-facing polished report. */
export function publicReportPath(runDir: string): string {
  return join(runDir, 'public_report.md');
}

/** Lifecycle/status JSON written by the background runner and the spine. */
export function runStatusPath(runDir: string): string {
  return join(runDir, 'run-status.json');
}

/** Snapshot of run parameters (concurrency, mode, axes, models). */
export function runConfigPath(runDir: string): string {
  return join(runDir, 'run-config.json');
}

/** Aggregated timings, costs, axis stats, timeline. */
export function runMetricsPath(runDir: string): string {
  return join(runDir, 'run-metrics.json');
}

/** Top-level error log (bootstrap / background spawn failure). */
export function runErrorLogPath(runDir: string): string {
  return join(runDir, 'error.log');
}

/** Markdown excerpt of the referenced documentation for the report phase. */
export function docReferenceSectionPath(runDir: string): string {
  return join(runDir, 'doc-reference-section.md');
}

/** Structured event stream for mini-runs (scan/estimate/review/watch). */
export function runEventLogPath(runDir: string): string {
  return join(runDir, 'anatoly.ndjson');
}

/** stdout/stderr of the background subprocess. */
export function backgroundLogPath(runDir: string): string {
  return join(runDir, 'background.log');
}

// --------------------------------------------------------------------------
// Costs
// --------------------------------------------------------------------------

/** Per-call LLM ledger (newline-delimited JSON). */
export function costsLedgerPath(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.costs, 'ledger.ndjson');
}

/** Aggregated costs by phase/composer/primitive/provider/model. */
export function costsSummaryPath(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.costs, 'summary.json');
}

/** Estimate vs. actual deviation by composer/phase. */
export function costsVariancePath(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.costs, 'variance.json');
}

// --------------------------------------------------------------------------
// Axes
// --------------------------------------------------------------------------

/** Per-axis overview / methodology page. */
export function axisIndexPath(runDir: string, axis: string): string {
  return join(runDir, RUN_SUBDIRS.axes, axis, 'index.md');
}

/** Per-axis shard (batch of files, sorted by severity). */
export function axisShardPath(runDir: string, axis: string, shardIndex: number): string {
  return join(runDir, RUN_SUBDIRS.axes, axis, `shard.${shardIndex}.md`);
}

// --------------------------------------------------------------------------
// Reviews
// --------------------------------------------------------------------------

/** Structured per-file review payload (`reviews/<n>.rev.json`). */
export function reviewJsonPath(runDir: string, filePath: string): string {
  return join(runDir, RUN_SUBDIRS.reviews, `${toOutputName(filePath)}.rev.json`);
}

/** Human-readable per-file review (`reviews/<n>.rev.md`). */
export function reviewMarkdownPath(runDir: string, filePath: string): string {
  return join(runDir, RUN_SUBDIRS.reviews, `${toOutputName(filePath)}.rev.md`);
}

// --------------------------------------------------------------------------
// Logs
// --------------------------------------------------------------------------

/** Per-file evaluation transcript (`logs/<n>.log`). */
export function transcriptLogPath(runDir: string, filePath: string): string {
  return join(runDir, RUN_SUBDIRS.logs, `${toOutputName(filePath)}.log`);
}

/** RAG indexing log stream. */
export function ragIndexLogPath(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.logs, 'rag-index.log');
}

/** Doc-generation scaffold log for one doc slug. */
export function docScaffoldLogPath(runDir: string, slug: string): string {
  return join(runDir, RUN_SUBDIRS.logs, `doc-scaffold__${slug}.md`);
}

/** Doc-generation summary. */
export function docGenSummaryLogPath(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.logs, 'summary.md');
}

/** Doc-coherence review log. */
export function docCoherenceReviewLogPath(runDir: string): string {
  return join(runDir, RUN_SUBDIRS.logs, 'coherence-review.md');
}

// --------------------------------------------------------------------------
// Conversations
// --------------------------------------------------------------------------

/**
 * Resolve the on-disk path of one conversation dump.
 *
 * `slug` is currently composed at the call site (per-axis evaluators,
 * RAG indexer, doc-conflict detector, etc.). PR 2 of doc 19 (= doc 15
 * §6 PR 3) will move slug derivation into the harness so this call
 * shape stays the same while the source of the slug changes.
 */
export function conversationDumpPath(runDir: string, slug: string, attempt: number): string {
  return join(runDir, RUN_SUBDIRS.conversations, `${slug}__${attempt}.md`);
}
