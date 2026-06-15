// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * LLM-assisted audit-scope suggestion (PR 2 of doc 21).
 *
 * Given the project file tree, a single model pass proposes directories or
 * file groups that are not hand-authored product surface, each tagged with a
 * category so the caller can route it. `fixture` / `generated` / `example`
 * are EXCLUDED from the audit; `vendored` (third-party code copied in) stays
 * AUDITED but the best-practices axis flags only real defects there (no style
 * churn), so the divergence-from-upstream concern is respected without losing
 * bug / dead-code detection. The deterministic `autoDetectScanGlobs` heuristic
 * stays the baseline; this only enriches the candidate list before the surgical
 * merge, and runs only in the interactive `init --scope` path where a human
 * reviews and confirms the diff.
 *
 * The decision is never applied live: the caller materializes the result into
 * `scan.exclude` (or `scan.vendored` for the vendored category, with
 * confirmation), and every later `run` reads the frozen config. See
 * docs/02-Architecture/21-Scope-Reconfiguration-Phase.md.
 */

import { z } from 'zod';
import type { Config } from '../../schemas/config.js';
import type { TransportRouter } from '../transports/index.js';
import { runSingleTurnQuery } from '../evaluation/index.js';
import { buildProjectTree } from './project-tree.js';

export type ExcludeCategory = 'fixture' | 'generated' | 'example' | 'vendored';

export interface ExcludeSuggestion {
  /** Glob to add to scan.exclude — or scan.vendored when category is 'vendored'
   *  (audited but best-practices-limited). E.g. "src/__fixtures__/**". */
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

const SYSTEM_PROMPT = `You classify parts of a repository that are NOT hand-authored product surface, so the audit can treat them appropriately.

You see ONLY the file/directory tree (paths, not contents), so recognize non-product code by well-known naming and directory conventions.

How each category is treated downstream (so you classify, not decide policy):
- fixture / generated / example → EXCLUDED from the audit entirely.
- vendored → still AUDITED, but the best-practices axis flags only real defects (bugs, security, dead code), never stylistic churn. So vendored is the safe choice for third-party copied-in code: real bugs are still caught, but style noise that would complicate upstream resync is suppressed.

Eligible categories:
- fixture: deliberately bad/dead/sample code used to calibrate tools or tests (__fixtures__, __mocks__, gold-set / golden dirs, testdata).
- generated: machine-emitted code not authored by hand. Beyond obvious codegen and build output (codegen, protobuf .pb, compiled or bundled output), this includes type/client definitions emitted by schema, BaaS, or ORM tooling, recognizable by convention, e.g.:
    - Supabase generated database types: "**/integrations/supabase/types.ts", "**/supabase/types.ts", "**/database.types.ts", "**/supabase/database.types.ts".
    - GraphQL / API codegen output: "**/__generated__/**", "**/*.generated.ts", "**/gql/**".
    - Prisma / ORM clients, OpenAPI/Swagger generated SDK clients, generated router trees (e.g. "**/routeTree.gen.ts").
- example: standalone demos / examples / samples that are not shipped product.
- vendored: third-party code copied into the repo, including UI primitive libraries scaffolded by a copy-in CLI rather than hand-authored, recognizable by convention, e.g.:
    - shadcn/ui primitives: "**/components/ui/**" (a directory of many small components each wrapping Radix / headless primitives, added by \`npx shadcn add\`; style-noise heavy but worth auditing for real bugs/dead code).

Rules:
- Propose GLOBS that match directories or file groups (e.g. "src/__fixtures__/**", "**/components/ui/**", "**/supabase/types.ts"), never an individual product file you hand-pick. The named single-file generated conventions above (e.g. the Supabase types file) are an exception: propose them as their convention glob.
- The named ecosystem conventions above (Supabase generated types, shadcn/ui under components/ui) ARE high-confidence: propose them whenever the tree matches, even under src/.
- For the EXCLUDE categories (fixture/generated/example): a wrongly-excluded real file is a silently-missed bug, far worse than auditing some noise. When unsure, DO NOT propose it. Bias hard toward fewer, high-confidence exclusions. (The vendored category is lower-stakes since those files stay audited.)
- Never propose product source, configuration, or anything you are not confident is non-product.
- Do NOT propose test files (*.test.*, *.spec.*) or standard vendor/build dirs (node_modules, dist, build, coverage): those are handled elsewhere.
- Return an empty list if nothing clearly qualifies.`;

export interface ProposeExcludesParams {
  projectRoot: string;
  config: Config;
  router: TransportRouter;
  /** Relative file paths currently in the audit surface (post scan.exclude). */
  files: string[];
  /** Model ref for the call. Resolve via `resolveCommandModel(config, 'scope')`
   *  at the call site. Falls back to `models.quality` (single-turn) when omitted. */
  model?: string;
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
  const model = params.model ?? config.models.quality;
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
