// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import type { Config } from '../../schemas/config.js';
import type { AxisId } from '../evaluation/contract.js';
import { pkgVersion, pkgCommit } from '../../utils/version.js';
import { runConfigPath } from '../../utils/run-layout.js';

export type DocMode = 'off' | 'lite' | 'full';
type RagMode = 'lite' | 'advanced' | 'auto';

/**
 * Resolve the documentation internal mode from a validated Config.
 * Returns a strict union — never undefined, never a generic string.
 * Centralizes the check so call-sites don't repeat optional-chaining.
 */
export function resolveDocMode(config: Config): DocMode {
  return config.documentation.internal.mode;
}

interface RunConfigBadge {
  enabled: boolean;
  verdict: boolean;
  link?: string;
}

/**
 * Snapshot of the parameters and resolved config used for a single run.
 * Persisted as `<runDir>/run-config.json` and consumed by downstream
 * tooling (e.g. anatoly-bench) — treat the shape as a stable contract.
 */
export interface RunConfig {
  runId: string;
  timestamp: string;
  anatolyVersion: string;
  anatolyCommit: string;
  projectRoot: string;
  concurrency: number;
  ragMode: RagMode;
  enableRag: boolean;
  noCache: boolean;
  /** When true, the run forced re-evaluation AND wrote fresh reviews back
   *  to the project-global cache, overwriting prior entries. Distinct from
   *  `noCache: true` which bypasses cache without touching it. */
  cacheRefresh?: boolean;
  rebuildRag?: boolean;
  deliberation: boolean;
  dryRun: boolean;
  axesFilter: AxisId[] | null;
  fileFilter: string | null;
  badge: RunConfigBadge;
  config: {
    providers: Config['providers'];
    models: Config['models'];
    agents: Config['agents'];
    runtime: Config['runtime'];
    axes: Config['axes'];
    rag: Config['rag'];
    scan: Config['scan'];
  };
}

export interface BuildRunConfigInput {
  runId: string;
  projectRoot: string;
  concurrency: number;
  ragMode: RagMode;
  enableRag: boolean;
  noCache: boolean;
  cacheRefresh?: boolean;
  rebuildRag?: boolean;
  deliberation: boolean;
  dryRun: boolean;
  axesFilter?: AxisId[];
  fileFilter?: string;
  badge: RunConfigBadge;
  config: Config;
}

export function buildRunConfig(input: BuildRunConfigInput): RunConfig {
  return {
    runId: input.runId,
    timestamp: new Date().toISOString(),
    anatolyVersion: pkgVersion,
    anatolyCommit: pkgCommit,
    projectRoot: input.projectRoot,
    concurrency: input.concurrency,
    ragMode: input.ragMode,
    enableRag: input.enableRag,
    noCache: input.noCache,
    cacheRefresh: input.cacheRefresh,
    rebuildRag: input.rebuildRag,
    deliberation: input.deliberation,
    dryRun: input.dryRun,
    axesFilter: input.axesFilter ?? null,
    fileFilter: input.fileFilter ?? null,
    badge: input.badge,
    config: {
      providers: input.config.providers,
      models: input.config.models,
      agents: input.config.agents,
      runtime: input.config.runtime,
      axes: input.config.axes,
      rag: input.config.rag,
      scan: input.config.scan,
    },
  };
}

/** The run-scoped scope filters a resume must carry over from the prior run. */
export interface ResumedScope {
  axesFilter: AxisId[] | undefined;
  fileFilter: string | undefined;
}

/**
 * Resolve the axis/file scope of a resumed run.
 *
 * `--resume` reuses the prior run's id but the CLI re-parses scope flags from
 * scratch, so a resume invoked without `--axes`/`--file` would silently widen
 * back to the full config axis set and whole tree (the "3 axes resumes as 7"
 * full re-diff). This restores the persisted scope, while letting an explicit
 * flag on the resume command still win.
 *
 * @param resumed The run-config of the run being resumed, or null (legacy run /
 *                not a resume) — in which case `current` passes through.
 * @param current Scope parsed from THIS invocation's flags (undefined = unset).
 */
export function resolveResumedScope(resumed: RunConfig | null, current: ResumedScope): ResumedScope {
  if (!resumed) return current;
  return {
    axesFilter: current.axesFilter ?? resumed.axesFilter ?? undefined,
    fileFilter: current.fileFilter ?? resumed.fileFilter ?? undefined,
  };
}

export function writeRunConfig(runDir: string, config: RunConfig): void {
  writeFileSync(runConfigPath(runDir), JSON.stringify(config, null, 2));
}

/**
 * Read the persisted RunConfig for an existing run directory. Returns null
 * when the file is missing or unparsable so callers (e.g. `anatoly report`)
 * can degrade gracefully on legacy runs without a config snapshot.
 *
 * Note: not validated against a schema — anatoly-bench treats this as a
 * stable contract, so the shape is trusted at load time.
 */
export function readRunConfig(runDir: string): RunConfig | null {
  const path = runConfigPath(runDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RunConfig;
  } catch {
    return null;
  }
}
