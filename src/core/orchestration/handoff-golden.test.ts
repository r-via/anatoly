// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Orchestration handoff golden (doc 11, PR 8b).
 *
 * The spine golden ([spine-golden.test.ts](./spine-golden.test.ts)) asserts
 * the phase *sequence* with a source-free fixture, so every §4 handoff value
 * is zero. That makes it a weak guard for PR 8c, which inverts the
 * setup -> review -> report handoff from `ctx` mutation to a typed object.
 *
 * This golden drives a run that produces **non-zero, deterministic** handoff
 * values (`filesReviewed=1`, `evaluated=1`, `findings=6`) so a regression in
 * how that data flows between phases changes the projection and fails here.
 *
 * Still hermetic and zero-LLM: the fixture's `src/dead.ts` has exports nothing
 * imports, so `UtilityEvaluator` resolves each symbol DEAD straight from the
 * usage graph with no model call. Run under `ANATOLY_TRANSPORT=replay` with an
 * empty cassette, so any model call would `cassette miss` and fail the test.
 * `--no-triage` forces the file to be reviewed regardless of triage heuristics
 * (the triage phase is intentionally absent from this fixture's projection as
 * a result). The run exits 1 (findings present); that is expected.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '../../..');
const DIST_ENTRY = join(REPO_ROOT, 'dist', 'index.js');
const FIXTURE_DIR = join(REPO_ROOT, 'src', '__fixtures__', 'orchestration-handoff');

/**
 * Fixed projection for the unused-exports fixture. Deterministic: the usage
 * graph resolves the two exported, zero-importer functions to DEAD with no
 * LLM, yielding a stable findings count. `triage` is absent (--no-triage);
 * `report` has a `phase_start` but no `phaseDurations` key because
 * run-metrics.json is written from inside the report phase, before its exit
 * effect assigns the duration (same load-bearing asymmetry as the spine
 * golden). The non-zero filesReviewed/evaluated/findings are exactly the §4
 * handoff values PR 8c must preserve.
 */
const BASELINE = {
  phaseStartOrder: ['scan', 'estimate', 'rag-index', 'review', 'report'],
  phaseDurationKeys: ['estimate', 'rag-index', 'review', 'scan'],
  filesReviewed: 1,
  evaluated: 1,
  findings: 6,
} as const;

interface RunMetrics {
  timeline: Array<{ event: string; phase?: string }>;
  phaseDurations: Record<string, number>;
  filesReviewed: number;
  evaluated: number;
  findings: number;
}

function projectionFrom(metrics: RunMetrics) {
  return {
    phaseStartOrder: metrics.timeline
      .filter(e => e.event === 'phase_start' && typeof e.phase === 'string')
      .map(e => e.phase as string),
    phaseDurationKeys: Object.keys(metrics.phaseDurations).sort(),
    filesReviewed: metrics.filesReviewed,
    evaluated: metrics.evaluated,
    findings: metrics.findings,
  };
}

let workdir: string;

describe('orchestration handoff golden', () => {
  beforeAll(() => {
    // Always build so the golden exercises current source, never a stale
    // artifact (dist/ is gitignored, so it may be absent or outdated).
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
    expect(existsSync(DIST_ENTRY)).toBe(true);
  }, 180_000);

  afterAll(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it(
    'threads non-zero setup -> review -> report handoff values through the pipeline',
    () => {
      workdir = mkdtempSync(join(tmpdir(), 'anatoly-handoff-golden-'));
      cpSync(FIXTURE_DIR, workdir, { recursive: true });
      const cassettePath = join(workdir, 'cassette.json'); // intentionally absent

      const proc = spawnSync(
        process.execPath,
        [
          DIST_ENTRY,
          'run',
          '--plain',
          '--defaults-settings',
          '--no-connectivity-check',
          '--no-deliberation',
          '--no-badge',
          '--no-cache',
          '--no-triage',
        ],
        {
          cwd: workdir,
          env: {
            ...process.env,
            ANATOLY_TRANSPORT: 'replay',
            ANATOLY_TRANSPORT_CASSETTE: cassettePath,
          },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      const out = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;

      // Zero model calls: a cassette miss means a phase reached a transport,
      // which breaks hermeticity and makes the projection meaningless.
      expect(out, `unexpected model call:\n${out.slice(-2000)}`).not.toContain('cassette miss');
      // Findings present -> exit code 1 is the contract here (not a failure).
      expect(proc.status, `unexpected exit code:\n${out.slice(-3000)}`).toBe(1);

      const runsDir = join(workdir, '.anatoly', 'runs');
      const runIds = readdirSync(runsDir).filter(n => /^\d{4}-\d{2}-\d{2}_/.test(n));
      expect(runIds, `expected exactly one run dir, got ${JSON.stringify(runIds)}`).toHaveLength(1);

      const metricsPath = join(runsDir, runIds[0], 'run-metrics.json');
      expect(existsSync(metricsPath), `run-metrics.json missing:\n${out.slice(-3000)}`).toBe(true);

      const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as RunMetrics;
      expect(projectionFrom(metrics)).toEqual(BASELINE);
    },
    240_000,
  );
});
