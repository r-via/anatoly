// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeFlowVerdicts, FlowEvaluator } from './flow.js';
import { writeFlowArtifact } from '../../flows/flow-writer.js';
import type { AxisContext } from '../contract.js';
import type { Task } from '../../../schemas/task.js';
import type { Config } from '../../../schemas/config.js';
import { parseTestConfig } from '../../../schemas/test-fixtures.js';
import type { UserFlow } from '../../../schemas/user-flow.js';

// ---------------------------------------------------------------------------
// Fixtures — fully synthetic flows, no filesystem, no LLM.
// ---------------------------------------------------------------------------

function flow(overrides: Partial<UserFlow> = {}): UserFlow {
  return {
    id: overrides.id ?? `flow:src/a.ts::${overrides.entry?.symbol ?? 'entry'}`,
    name: overrides.entry?.symbol ?? 'entry',
    finality: 'does a thing',
    entry: { file: 'src/a.ts', symbol: 'entry', kind: 'side_effect' },
    steps: [],
    effects: [{ file: 'src/c.ts', symbol: 'saveRow', kind: 'side_effect' }],
    confidence: 100,
    unwired: false,
    ...overrides,
  };
}

/** A resolveDead stub: every named (file::symbol) reports DEAD. */
const deadFor = (...keys: string[]) => {
  const set = new Set(keys);
  return (entry: { file: string; symbol: string }): boolean => set.has(`${entry.file}::${entry.symbol}`);
};
const neverDead = (): boolean => false;

// ---------------------------------------------------------------------------
// computeFlowVerdicts — the bench-critical core (axis, verdict, file, symbol).
// ---------------------------------------------------------------------------

describe('computeFlowVerdicts', () => {
  it('flags an unwired flow whose entry resolves DEAD (dead intent)', () => {
    const f = flow({
      id: 'flow:src/a.ts::previewTask',
      entry: { file: 'src/a.ts', symbol: 'previewTask', kind: 'side_effect' },
      effects: [],
      unwired: true,
    });
    const verdicts = computeFlowVerdicts([f], deadFor('src/a.ts::previewTask'));
    expect(verdicts.get(f.id)?.nature).toBe('unwired_flow');
  });

  it('does NOT flag an unwired flow whose entry is still imported (public query FP guard)', () => {
    // loadSummary is unwired (reaches no effect) but re-exported through the
    // barrel and imported elsewhere, so the usage graph says it is not DEAD.
    const f = flow({
      id: 'flow:src/a.ts::loadSummary',
      entry: { file: 'src/a.ts', symbol: 'loadSummary', kind: 'side_effect' },
      effects: [],
      unwired: true,
    });
    expect(computeFlowVerdicts([f], neverDead).has(f.id)).toBe(false);
  });

  it('skips the unwired detector entirely when no symbol resolves DEAD (no usage graph)', () => {
    const f = flow({ effects: [], unwired: true });
    expect(computeFlowVerdicts([f], neverDead).size).toBe(0);
  });

  it('flags both members of two wired flows with an identical step + effect set (redundant twins)', () => {
    const steps = [{ file: 'src/b.ts', symbol: 'fmt', role: 'transform' as const }];
    const effects = [{ file: 'src/c.ts', symbol: 'saveTask', kind: 'side_effect' as const }];
    const a = flow({ id: 'flow:src/a.ts::noteTask', entry: { file: 'src/a.ts', symbol: 'noteTask', kind: 'side_effect' }, steps, effects });
    const b = flow({ id: 'flow:src/a.ts::annotateTask', entry: { file: 'src/a.ts', symbol: 'annotateTask', kind: 'side_effect' }, steps, effects });
    const verdicts = computeFlowVerdicts([a, b], neverDead);
    expect(verdicts.get(a.id)?.nature).toBe('redundant_flow');
    expect(verdicts.get(b.id)?.nature).toBe('redundant_flow');
  });

  it('does NOT flag a structurally unique wired flow', () => {
    const a = flow({ id: 'flow:src/a.ts::addTask', entry: { file: 'src/a.ts', symbol: 'addTask', kind: 'side_effect' }, steps: [{ file: 'src/b.ts', symbol: 'x', role: 'transform' }], effects: [{ file: 'src/c.ts', symbol: 'saveTask', kind: 'side_effect' }] });
    const b = flow({ id: 'flow:src/a.ts::removeTask', entry: { file: 'src/a.ts', symbol: 'removeTask', kind: 'side_effect' }, steps: [{ file: 'src/b.ts', symbol: 'y', role: 'transform' }], effects: [{ file: 'src/c.ts', symbol: 'dropTask', kind: 'side_effect' }] });
    expect(computeFlowVerdicts([a, b], neverDead).size).toBe(0);
  });

  it('flags ONLY the deficient sibling that omits a guard transform its sibling performs', () => {
    const effects = [{ file: 'src/c.ts', symbol: 'saveTask', kind: 'side_effect' as const }];
    const deficient = flow({
      id: 'flow:src/a.ts::importTask',
      entry: { file: 'src/a.ts', symbol: 'importTask', kind: 'side_effect' },
      steps: [{ file: 'src/b.ts', symbol: 'route', role: 'async' }],
      effects,
    });
    const reference = flow({
      id: 'flow:src/a.ts::addTask',
      entry: { file: 'src/a.ts', symbol: 'addTask', kind: 'side_effect' },
      steps: [
        { file: 'src/b.ts', symbol: 'route', role: 'async' },
        { file: 'src/b.ts', symbol: 'validateTask', role: 'transform' },
      ],
      effects,
    });
    const verdicts = computeFlowVerdicts([deficient, reference], neverDead);
    expect(verdicts.get(deficient.id)?.nature).toBe('inconsistent_siblings');
    expect(verdicts.has(reference.id)).toBe(false);
  });

  it('flags a wired flow routed through INDIRECTION_CAP+ pure transform hops (over-indirect)', () => {
    const f = flow({
      id: 'flow:src/a.ts::completeViaPipeline',
      entry: { file: 'src/a.ts', symbol: 'completeViaPipeline', kind: 'side_effect' },
      steps: [
        { file: 'src/b.ts', symbol: 'h1', role: 'transform' },
        { file: 'src/b.ts', symbol: 'h2', role: 'transform' },
      ],
      effects: [{ file: 'src/c.ts', symbol: 'saveTask', kind: 'side_effect' }],
    });
    expect(computeFlowVerdicts([f], neverDead).get(f.id)?.nature).toBe('over_indirect');
  });

  it('does NOT flag a wired flow with a single transform hop', () => {
    const f = flow({ steps: [{ file: 'src/b.ts', symbol: 'h1', role: 'transform' }] });
    expect(computeFlowVerdicts([f], neverDead).has(f.id)).toBe(false);
  });

  it('flags a create/enqueue effect on an entity nothing ever tears down (effect asymmetry)', () => {
    const f = flow({
      id: 'flow:src/a.ts::registerUser',
      entry: { file: 'src/a.ts', symbol: 'registerUser', kind: 'side_effect' },
      effects: [{ file: 'src/c.ts', symbol: 'createUser', kind: 'side_effect' }],
    });
    expect(computeFlowVerdicts([f], neverDead).get(f.id)?.nature).toBe('effect_asymmetry');
  });

  it('does NOT flag a create effect when a teardown flow exists for the same entity', () => {
    const create = flow({
      id: 'flow:src/a.ts::registerUser',
      entry: { file: 'src/a.ts', symbol: 'registerUser', kind: 'side_effect' },
      effects: [{ file: 'src/c.ts', symbol: 'createUser', kind: 'side_effect' }],
    });
    const teardown = flow({
      id: 'flow:src/a.ts::retireUser',
      entry: { file: 'src/a.ts', symbol: 'retireUser', kind: 'side_effect' },
      effects: [{ file: 'src/c.ts', symbol: 'deleteUserRow', kind: 'side_effect' }],
    });
    expect(computeFlowVerdicts([create, teardown], neverDead).has(create.id)).toBe(false);
  });

  it('honours nature precedence (redundant outranks effect_asymmetry on the same flow)', () => {
    const steps = [{ file: 'src/b.ts', symbol: 'fmt', role: 'transform' as const }];
    const effects = [{ file: 'src/c.ts', symbol: 'createUser', kind: 'side_effect' as const }];
    const a = flow({ id: 'flow:src/a.ts::seedUserA', entry: { file: 'src/a.ts', symbol: 'seedUserA', kind: 'side_effect' }, steps, effects });
    const b = flow({ id: 'flow:src/a.ts::seedUserB', entry: { file: 'src/a.ts', symbol: 'seedUserB', kind: 'side_effect' }, steps, effects });
    expect(computeFlowVerdicts([a, b], neverDead).get(a.id)?.nature).toBe('redundant_flow');
  });
});

// ---------------------------------------------------------------------------
// FlowEvaluator — artifact loading + per-entry emission, zero cost, no LLM.
// ---------------------------------------------------------------------------

describe('FlowEvaluator.evaluate', () => {
  let root: string;
  const config: Config = parseTestConfig({});

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anatoly-flow-axis-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ctx(task: Task, overrides: Partial<AxisContext> = {}): AxisContext {
    return { task, fileContent: '', config, projectRoot: root, ...overrides };
  }

  function task(file: string, symbols: Array<{ name: string }>): Task {
    return {
      version: 1,
      file,
      hash: 'h',
      symbols: symbols.map((s) => ({ name: s.name, kind: 'function', exported: true, line_start: 1, line_end: 5 })),
      scanned_at: '2026-06-15T00:00:00Z',
    };
  }

  it('returns an empty zero-cost result when no flows.json exists', async () => {
    const res = await new FlowEvaluator().evaluate(ctx(task('src/a.ts', [{ name: 'entry' }])), new AbortController());
    expect(res.symbols).toEqual([]);
    expect(res.costUsd).toBe(0);
    expect(res.transcript).toBe('');
  });

  it('emits OK for a healthy flow entry rooted in the current file', async () => {
    writeFlowArtifact(root, [flow({ entry: { file: 'src/a.ts', symbol: 'entry', kind: 'side_effect' } })]);
    const res = await new FlowEvaluator().evaluate(ctx(task('src/a.ts', [{ name: 'entry' }])), new AbortController());
    expect(res.symbols).toHaveLength(1);
    expect(res.symbols[0]).toMatchObject({ name: 'entry', value: 'OK' });
    expect(res.costUsd).toBe(0);
    expect(res.inputTokens).toBe(0);
    expect(res.outputTokens).toBe(0);
  });

  it('emits NEEDS_FIX for a defective (over-indirect) flow entry rooted in the current file', async () => {
    writeFlowArtifact(root, [
      flow({
        id: 'flow:src/a.ts::completeViaPipeline',
        entry: { file: 'src/a.ts', symbol: 'completeViaPipeline', kind: 'side_effect' },
        steps: [
          { file: 'src/b.ts', symbol: 'h1', role: 'transform' },
          { file: 'src/b.ts', symbol: 'h2', role: 'transform' },
        ],
      }),
    ]);
    const res = await new FlowEvaluator().evaluate(
      ctx(task('src/a.ts', [{ name: 'completeViaPipeline' }])),
      new AbortController(),
    );
    expect(res.symbols[0]).toMatchObject({ name: 'completeViaPipeline', value: 'NEEDS_FIX' });
    expect(res.symbols[0]?.detail).toContain('over_indirect');
  });

  it('does not emit for flow entries rooted in a different file', async () => {
    writeFlowArtifact(root, [flow({ id: 'flow:src/other.ts::entry', entry: { file: 'src/other.ts', symbol: 'entry', kind: 'side_effect' } })]);
    const res = await new FlowEvaluator().evaluate(ctx(task('src/a.ts', [{ name: 'entry' }])), new AbortController());
    expect(res.symbols).toEqual([]);
  });

  it('skips an unwired entry when no usage graph is available (no false positive)', async () => {
    writeFlowArtifact(root, [
      flow({
        id: 'flow:src/a.ts::previewTask',
        entry: { file: 'src/a.ts', symbol: 'previewTask', kind: 'side_effect' },
        effects: [],
        unwired: true,
      }),
    ]);
    const res = await new FlowEvaluator().evaluate(ctx(task('src/a.ts', [{ name: 'previewTask' }])), new AbortController());
    // The entry still renders (it is a flow rooted here) but, with no usage
    // graph to confirm DEAD, it is OK rather than a false NEEDS_FIX.
    expect(res.symbols[0]).toMatchObject({ name: 'previewTask', value: 'OK' });
  });
});
