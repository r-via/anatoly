// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Centralized observability for standalone commands that make LLM calls
 * outside an audit run (`docs arbitrate refresh`, `init --scope`).
 *
 * An audit run opens three scopes around its LLM work; standalone commands
 * historically opened none, which is why their conversation dirs came out
 * empty (buildDumpSlug throws on the missing `phase` field) and why nothing
 * about the call was persisted. This helper opens the same three scopes so a
 * command's transcripts, cost ledger and structured logs all land under
 * `.anatoly/commands/<command>/<timestamp>/`:
 *
 *  1. a per-command file logger -> `<dir>/anatoly.ndjson`
 *  2. the ALS log-context `{ phase: command, runId: ts }` — `phase` is
 *     REQUIRED by `buildDumpSlug`, so this is what makes conversation dumps
 *     actually write,
 *  3. the LLM-call sink -> `<dir>/costs/ledger.ndjson`, so every
 *     `recordLlmCall` the transport emits is captured.
 */

import { mkdirSync } from 'node:fs';
import { commandPath } from '../../utils/anatoly-paths.js';
import { pruneTimestampedRuns } from '../../utils/command-retention.js';
import { conversationsDir, runEventLogPath, costsLedgerPath } from '../../utils/run-layout.js';
import { runWithContext } from '../../utils/log-context.js';
import { withLlmCallSink } from '../../utils/llm-calls-sink.js';
import { createFileLogger, flushFileLogger } from '../../utils/logger.js';

export interface CommandObservability {
  /** `<project>/.anatoly/commands/<command>/<timestamp>/`. */
  runDir: string;
  /** Pass to LLM calls so their transcripts dump here. */
  conversationDir: string;
}

const DEFAULT_KEEP = 10;

/**
 * Run `fn` inside the centralized observability scope for a standalone
 * command. Returns whatever `fn` returns. The timestamp is the directory key;
 * old dirs beyond `keep` are pruned best-effort first.
 */
export async function withCommandObservability<T>(
  projectRoot: string,
  command: string,
  fn: (obs: CommandObservability) => Promise<T>,
  opts: { keep?: number } = {},
): Promise<T> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  pruneTimestampedRuns(commandPath(projectRoot, command), (opts.keep ?? DEFAULT_KEEP) - 1);
  const runDir = commandPath(projectRoot, command, ts);
  mkdirSync(runDir, { recursive: true });
  createFileLogger(runEventLogPath(runDir));
  try {
    return await runWithContext({ phase: command, runId: ts }, () =>
      withLlmCallSink(costsLedgerPath(runDir), () =>
        fn({ runDir, conversationDir: conversationsDir(runDir) }),
      ),
    );
  } finally {
    flushFileLogger();
  }
}
