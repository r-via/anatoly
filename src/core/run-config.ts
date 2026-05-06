// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../schemas/config.js';
import type { AxisId } from './axis-evaluator.js';
import { pkgVersion, pkgCommit } from '../utils/version.js';

export type RagMode = 'lite' | 'advanced' | 'auto';

export interface RunConfigBadge {
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

export function writeRunConfig(runDir: string, config: RunConfig): void {
  writeFileSync(join(runDir, 'run-config.json'), JSON.stringify(config, null, 2));
}
