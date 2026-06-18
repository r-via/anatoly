// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Orchestration goldens (doc 11). Two regression nets that drive a full
 * `anatoly run` through the real pipeline spine and assert an
 * order-normalized projection of run-metrics.json.
 *
 * 1. Spine golden (PR 1): a source-free fixture, so the review phase makes
 *    zero model calls and every §4 handoff value is zero. Guards the phase
 *    sequence + gates. Deleting or reordering any `runPhase(...)` call
 *    changes `phaseStartOrder` / `phaseDurationKeys` and fails it (proven by
 *    a deliberate reorder, see the PR 1 / 8a commit messages).
 *
 * 2. Handoff golden (PR 8b): a one-file fixture whose unused exports the
 *    usage graph resolves DEAD with no LLM, so the run is still hermetic but
 *    produces non-zero, deterministic handoff values (filesReviewed=1,
 *    evaluated=1, findings=2). Guards the setup -> review -> report handoff
 *    that PR 8c inverted from `ctx` mutation to the typed `Handoff` object
 *    (proven to catch a §4 regression, see the PR 8b commit message).
 *
 * Both are hermetic: `ANATOLY_TRANSPORT=replay` with an empty cassette, so
 * any model call throws `cassette miss` and fails the test. Both share one
 * `beforeAll` build so the two never race on `dist/` (they did when they
 * were separate files, each rebuilding in parallel: ENOENT on dist/index.js).
 *
 * Subprocess, not in-process: `anatoly run` has no in-process entry point;
 * the goldens spawn the built CLI and build `dist/` first (gitignored).
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
const FIXTURES = join(REPO_ROOT, 'src', '__fixtures__');

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

/** Run the built CLI against a temp copy of a fixture and project run-metrics. */
function runGolden(fixture: string, extraArgs: string[]): { proc: ReturnType<typeof spawnSync>; out: string; metrics: RunMetrics | null; workdir: string } {
  const workdir = mkdtempSync(join(tmpdir(), `anatoly-golden-${fixture}-`));
  cpSync(join(FIXTURES, fixture), workdir, { recursive: true });
  const proc = spawnSync(
    process.execPath,
    [DIST_ENTRY, 'run', '--plain', '--defaults-settings', '--no-connectivity-check', '--no-deliberation', '--no-badge', '--no-cache', ...extraArgs],
    {
      cwd: workdir,
      env: { ...process.env, ANATOLY_TRANSPORT: 'replay', ANATOLY_TRANSPORT_CASSETTE: join(workdir, 'cassette.json') },
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  const out = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
  const runsDir = join(workdir, '.anatoly', 'runs');
  let metrics: RunMetrics | null = null;
  if (existsSync(runsDir)) {
    const runIds = readdirSync(runsDir).filter(n => /^\d{4}-\d{2}-\d{2}_/.test(n));
    if (runIds.length === 1) {
      const m = join(runsDir, runIds[0], 'run-metrics.json');
      if (existsSync(m)) metrics = JSON.parse(readFileSync(m, 'utf8')) as RunMetrics;
    }
  }
  return { proc, out, metrics, workdir };
}

const workdirs: string[] = [];

describe('orchestration goldens', () => {
  beforeAll(() => {
    // One build shared by both goldens: separate files each rebuilding in
    // parallel raced on dist/ (ENOENT unlink dist/index.js).
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
    expect(existsSync(DIST_ENTRY)).toBe(true);
  }, 180_000);

  afterAll(() => {
    for (const w of workdirs) rmSync(w, { recursive: true, force: true });
  });

  it(
    'spine golden: source-free fixture, expected phase sequence, zero handoff, zero LLM',
    () => {
      const { proc, out, metrics, workdir } = runGolden('orchestration-golden', []);
      workdirs.push(workdir);
      expect(out, `unexpected model call:\n${out.slice(-2000)}`).not.toContain('cassette miss');
      expect(proc.status, `run did not exit cleanly:\n${out.slice(-3000)}`).toBe(0);
      expect(metrics, `run-metrics.json missing:\n${out.slice(-3000)}`).not.toBeNull();
      expect(projectionFrom(metrics!)).toEqual({
        // `flows` + `flow-doc` run by default now (FlowsConfigSchema default on).
        // Both no-op on a source-free fixture (no usage graph / no artifact) but
        // still record their phase boundary and zero LLM calls.
        phaseStartOrder: ['scan', 'estimate', 'triage', 'rag-index', 'flows', 'flow-doc', 'review', 'report'],
        phaseDurationKeys: ['estimate', 'flow-doc', 'flows', 'rag-index', 'review', 'scan', 'triage'],
        filesReviewed: 0,
        evaluated: 0,
        findings: 0,
      });
    },
    240_000,
  );

  it(
    'handoff golden: non-zero setup -> review -> report handoff threaded through the typed Handoff',
    () => {
      const { proc, out, metrics, workdir } = runGolden('orchestration-handoff', ['--no-triage']);
      workdirs.push(workdir);
      expect(out, `unexpected model call:\n${out.slice(-2000)}`).not.toContain('cassette miss');
      // Findings present -> exit 1 is the contract here (not a failure).
      expect(proc.status, `unexpected exit code:\n${out.slice(-3000)}`).toBe(1);
      expect(metrics, `run-metrics.json missing:\n${out.slice(-3000)}`).not.toBeNull();
      expect(projectionFrom(metrics!)).toEqual({
        // `flows` + `flow-doc` run by default now (FlowsConfigSchema default on);
        // both no-op without an LLM call but record their phase boundary.
        phaseStartOrder: ['scan', 'estimate', 'rag-index', 'flows', 'flow-doc', 'review', 'report'],
        phaseDurationKeys: ['estimate', 'flow-doc', 'flows', 'rag-index', 'review', 'scan'],
        filesReviewed: 1,
        evaluated: 1,
        // 2 DEAD exports → 2 findings. Only the `utility` axis is enabled in the
        // fixture config, so tests/documentation resolve to the '-' (skipped)
        // sentinel and must NOT be fabricated into NONE/UNDOCUMENTED findings
        // (axis-merger coherence guard). Pre-guard this was 6 (2 DEAD + 2 bogus
        // tests=NONE + 2 bogus doc=UNDOCUMENTED on axes that never ran).
        findings: 2,
      });
    },
    240_000,
  );
});
