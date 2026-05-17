// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Orchestration spine golden (doc 11, PR 1).
 *
 * This is the real regression net the Orchestration Remediation Plan requires:
 * it drives a full `anatoly run` through the actual spine in run.ts and asserts
 * the observed phase sequence, the executed-phase set, and the handoff values.
 * It replaces the hollow coverage/artefact-separation/cost-integrity tests,
 * which asserted source greps and pure functions, never the runtime path.
 *
 * Hermetic by construction: the fixture is source-free so the review phase
 * makes zero model calls, and the run executes under `ANATOLY_TRANSPORT=replay`
 * with an empty cassette. Any model call would throw `cassette miss` and abort
 * the run, so a green golden also proves the fixture stays at zero LLM calls.
 *
 * Drift detection (plan §10.2): deleting or reordering any `runPhase(...)` call
 * in the spine changes `phaseStartOrder` or `phaseDurationKeys`, failing this
 * test. Verified once by a deliberate local reorder (see the commit message).
 *
 * Subprocess, not in-process: `anatoly run` has no in-process entry point and
 * PR 1 does not touch run.ts, so the golden spawns the built CLI. It builds
 * `dist/` first so it always exercises current source (dist/ is gitignored).
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
const FIXTURE_DIR = join(REPO_ROOT, 'src', '__fixtures__', 'orchestration-golden');

/**
 * The canonical projection for the source-free fixture. Order-normalized and
 * value-free: run id and per-phase durations are excluded because they are
 * inherently nondeterministic; everything here is fixed by the spine + gates.
 *
 * `report` has a `phase_start` in the timeline but no `phaseDurations` key:
 * run-metrics.json is written from inside the report phase, before that
 * phase's exit effect assigns its duration. That asymmetry is itself a
 * load-bearing invariant, so it is asserted, not normalized away.
 */
const BASELINE = {
  phaseStartOrder: ['scan', 'estimate', 'triage', 'rag-index', 'review', 'report'],
  phaseDurationKeys: ['estimate', 'rag-index', 'review', 'scan', 'triage'],
  filesReviewed: 0,
  findings: 0,
} as const;

interface RunMetrics {
  timeline: Array<{ event: string; phase?: string }>;
  phaseDurations: Record<string, number>;
  filesReviewed: number;
  findings: number;
}

function projectionFrom(metrics: RunMetrics) {
  return {
    phaseStartOrder: metrics.timeline
      .filter(e => e.event === 'phase_start' && typeof e.phase === 'string')
      .map(e => e.phase as string),
    phaseDurationKeys: Object.keys(metrics.phaseDurations).sort(),
    filesReviewed: metrics.filesReviewed,
    findings: metrics.findings,
  };
}

let workdir: string;

describe('orchestration spine golden', () => {
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
    'drives the full pipeline through the spine with the expected phase sequence and handoff',
    () => {
      workdir = mkdtempSync(join(tmpdir(), 'anatoly-spine-golden-'));
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

      // The fixture must stay at zero model calls: a cassette miss means a
      // phase reached a transport, which both breaks hermeticity and means
      // the projection below is meaningless.
      expect(out, `unexpected model call:\n${out.slice(-2000)}`).not.toContain('cassette miss');
      expect(proc.status, `run did not exit cleanly:\n${out.slice(-3000)}`).toBe(0);

      const runsDir = join(workdir, '.anatoly', 'runs');
      // Ignore the `latest` pointer; real run dirs are timestamp-named.
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
