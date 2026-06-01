// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * LLM-assisted audit-scope suggestion (PR 2 of doc 21).
 *
 * Given the project file tree, a single model pass proposes directories or
 * file groups to EXCLUDE from the audit because they are not product surface
 * (fixtures, generated code, examples, vendored). The deterministic
 * `autoDetectScanGlobs` heuristic stays the baseline; this only enriches the
 * candidate list before the surgical merge, and runs only in the interactive
 * `init --scope` path where a human reviews and confirms the diff.
 *
 * The decision is never applied live: the caller materializes the result into
 * `scan.exclude` (with confirmation), and every later `run` reads the frozen
 * config. See docs/02-Architecture/21-Scope-Reconfiguration-Phase.md.
 */

import { z } from 'zod';
import type { Config } from '../../schemas/config.js';
import type { TransportRouter } from '../transports/index.js';
import { runSingleTurnQuery } from '../evaluation/index.js';
import { buildProjectTree } from './project-tree.js';

export type ExcludeCategory = 'fixture' | 'generated' | 'example' | 'vendored';

export interface ExcludeSuggestion {
  /** Glob to add to scan.exclude (e.g. "src/__fixtures__/**"). */
  glob: string;
  category: ExcludeCategory;
  /** One-line justification, shown in the confirm preview. */
  reason: string;
}

export const ProposeExcludesResponseSchema = z.object({
  excludes: z.array(
    z.object({
      glob: z.string().min(1),
      category: z.enum(['fixture', 'generated', 'example', 'vendored']),
      reason: z.string().min(1),
    }),
  ),
});

const SYSTEM_PROMPT = `You decide which parts of a repository should be EXCLUDED from a code audit because they are not product surface.

Eligible categories:
- fixture: deliberately bad/dead/sample code used to calibrate tools or tests (__fixtures__, __mocks__, gold-set / golden dirs, testdata).
- generated: machine-emitted code not authored by hand (codegen, protobuf .pb, compiled or bundled output).
- example: standalone demos / examples / samples that are not shipped product.
- vendored: third-party code copied into the repo.

Rules:
- Propose GLOBS that match directories or file groups (e.g. "src/__fixtures__/**", "**/generated/**"), never individual product files.
- A wrongly-excluded real file is a silently-missed bug, far worse than auditing some noise. When unsure, DO NOT propose it. Bias hard toward fewer, high-confidence exclusions.
- Never propose product source, configuration, or anything you are not confident is non-product.
- Do NOT propose test files (*.test.*, *.spec.*) or standard vendor/build dirs (node_modules, dist, build, coverage): those are handled elsewhere.
- Return an empty list if nothing clearly qualifies.`;

export interface ProposeExcludesParams {
  projectRoot: string;
  config: Config;
  router: TransportRouter;
  /** Relative file paths currently in the audit surface (post scan.exclude). */
  files: string[];
  /** Globs already present in scan.exclude — never re-proposed. */
  alreadyExcluded?: string[];
  abortController?: AbortController;
  /** When set, the LLM conversation transcript is dumped here (observability).
   *  Typically `<.anatoly/commands/scope/<timestamp>>/conversations/`. */
  conversationDir?: string;
  /** Injectable seam for hermetic tests; defaults to the real single-turn query. */
  queryFn?: typeof runSingleTurnQuery;
}

/**
 * Ask the model once for scope exclusions. Returns a de-duplicated list with
 * anything already excluded filtered out. Never throws on an empty tree.
 */
export async function proposeExcludes(params: ProposeExcludesParams): Promise<ExcludeSuggestion[]> {
  const { projectRoot, config, router, files } = params;
  if (files.length === 0) return [];

  const query = params.queryFn ?? runSingleTurnQuery;
  const model = config.models.deliberation || config.models.quality;
  const already = params.alreadyExcluded ?? [];
  const tree = buildProjectTree(files);
  const userMessage =
    `Project file tree:\n\n${tree}\n\n` +
    (already.length > 0
      ? `These globs are already excluded — do not repeat them:\n${already.map((g) => `- ${g}`).join('\n')}\n\n`
      : '') +
    'Propose the exclusions.';

  const ac = params.abortController ?? new AbortController();
  const result = await query(
    {
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      model,
      projectRoot,
      abortController: ac,
      composer: 'scope.propose-excludes',
      primitive: 'scope.propose-excludes',
      timeoutMs: config.runtime.timeout_per_call * 1000,
      router,
      ...(params.conversationDir ? { conversationDir: params.conversationDir, callId: 'propose-excludes' } : {}),
    },
    ProposeExcludesResponseSchema,
  );

  const alreadySet = new Set(already);
  const seen = new Set<string>();
  return result.data.excludes.filter((e) => {
    if (alreadySet.has(e.glob) || seen.has(e.glob)) return false;
    seen.add(e.glob);
    return true;
  });
}
