// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { buildFlowSkeletons } from './flow-walk.js';
import type { UsageGraph } from '../scanning/usage-graph.js';
import type { FunctionCard } from '../../rag/types.js';

// ---------------------------------------------------------------------------
// Fixture builders (hermetic — no I/O, no LLM).
// ---------------------------------------------------------------------------

type Profile = NonNullable<FunctionCard['behavioralProfile']>;

function card(
  filePath: string,
  name: string,
  opts: {
    profile?: Profile;
    calledInternals?: string[];
    referencedImports?: string[];
  } = {},
): FunctionCard {
  return {
    id: `${filePath}#${name}`,
    filePath,
    name,
    signature: `function ${name}()`,
    behavioralProfile: opts.profile,
    complexityScore: 1,
    calledInternals: opts.calledInternals ?? [],
    referencedImports: opts.referencedImports ?? [],
    lastIndexed: '2026-01-01T00:00:00.000Z',
  };
}

interface Edge {
  symbol: string;
  sourceFile: string;
  importer: string;
}

/** Build a UsageGraph from a list of runtime-import edges. */
function graph(edges: Edge[], reExports?: Map<string, Set<string>>): UsageGraph {
  const usages = new Map<string, Set<string>>();
  for (const e of edges) {
    const key = `${e.symbol}::${e.sourceFile}`;
    let set = usages.get(key);
    if (!set) {
      set = new Set<string>();
      usages.set(key, set);
    }
    set.add(e.importer);
  }
  return {
    usages,
    typeOnlyUsages: new Map(),
    intraFileRefs: new Map(),
    noImportFiles: new Set(),
    reExports,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildFlowSkeletons', () => {
  it('models a clean wired flow with steps, a terminal effect, and full confidence', () => {
    const cards = [
      card('src/api/handler.ts', 'handleRequest', {
        profile: 'sideEffectful',
        referencedImports: ['validate', 'saveUser'],
      }),
      card('src/api/validate.ts', 'validate', {
        profile: 'pure',
        calledInternals: ['normalize'],
      }),
      card('src/api/validate.ts', 'normalize', { profile: 'pure' }),
      card('src/db/user.ts', 'saveUser', { profile: 'stateful' }),
    ];
    const g = graph([
      { symbol: 'validate', sourceFile: 'src/api/validate.ts', importer: 'src/api/handler.ts' },
      { symbol: 'saveUser', sourceFile: 'src/db/user.ts', importer: 'src/api/handler.ts' },
    ]);

    const flows = buildFlowSkeletons({ cards, usageGraph: g });

    expect(flows).toHaveLength(1);
    const flow = flows[0]!;
    expect(flow.id).toBe('flow:src/api/handler.ts::handleRequest');
    expect(flow.name).toBe('handleRequest');
    expect(flow.entry).toEqual({
      file: 'src/api/handler.ts',
      symbol: 'handleRequest',
      kind: 'side_effect',
    });
    // Pre-order, deterministic: validate (and its same-file normalize) before saveUser.
    expect(flow.steps).toEqual([
      { file: 'src/api/validate.ts', symbol: 'validate', role: 'transform' },
      { file: 'src/api/validate.ts', symbol: 'normalize', role: 'transform' },
      { file: 'src/db/user.ts', symbol: 'saveUser', role: 'state' },
    ]);
    expect(flow.effects).toEqual([
      { file: 'src/db/user.ts', symbol: 'saveUser', kind: 'state_mutation' },
    ]);
    expect(flow.unwired).toBe(false);
    expect(flow.confidence).toBe(100);
  });

  it('marks an entry that reaches no effect as unwired (candidate dead-intent)', () => {
    const cards = [
      card('src/cli/cmd.ts', 'runCommand', {
        profile: 'async',
        referencedImports: ['format'],
      }),
      card('src/util/fmt.ts', 'format', { profile: 'pure' }),
    ];
    const g = graph([
      { symbol: 'format', sourceFile: 'src/util/fmt.ts', importer: 'src/cli/cmd.ts' },
    ]);

    const flows = buildFlowSkeletons({ cards, usageGraph: g });

    expect(flows).toHaveLength(1);
    expect(flows[0]!.entry.kind).toBe('async');
    expect(flows[0]!.effects).toEqual([]);
    expect(flows[0]!.unwired).toBe(true);
  });

  it('dedupes a shared tail so a converged node appears once', () => {
    const cards = [
      card('src/entry.ts', 'main', {
        profile: 'sideEffectful',
        referencedImports: ['left', 'right'],
      }),
      card('src/left.ts', 'left', { profile: 'pure', referencedImports: ['shared'] }),
      card('src/right.ts', 'right', { profile: 'pure', referencedImports: ['shared'] }),
      card('src/shared.ts', 'shared', { profile: 'sideEffectful' }),
    ];
    const g = graph([
      { symbol: 'left', sourceFile: 'src/left.ts', importer: 'src/entry.ts' },
      { symbol: 'right', sourceFile: 'src/right.ts', importer: 'src/entry.ts' },
      { symbol: 'shared', sourceFile: 'src/shared.ts', importer: 'src/left.ts' },
      { symbol: 'shared', sourceFile: 'src/shared.ts', importer: 'src/right.ts' },
    ]);

    const flows = buildFlowSkeletons({ cards, usageGraph: g });

    expect(flows).toHaveLength(1);
    const sharedSteps = flows[0]!.steps.filter((s) => s.symbol === 'shared');
    expect(sharedSteps).toHaveLength(1);
    // shared is sideEffectful → exactly one effect, also deduped.
    expect(flows[0]!.effects).toEqual([
      { file: 'src/shared.ts', symbol: 'shared', kind: 'side_effect' },
    ]);
  });

  it('is cycle-safe (a path that loops back terminates)', () => {
    const cards = [
      card('src/a.ts', 'entryA', { profile: 'sideEffectful', referencedImports: ['b'] }),
      card('src/b.ts', 'b', { profile: 'pure', referencedImports: ['entryA'] }),
    ];
    const g = graph([
      { symbol: 'b', sourceFile: 'src/b.ts', importer: 'src/a.ts' },
      { symbol: 'entryA', sourceFile: 'src/a.ts', importer: 'src/b.ts' },
    ]);

    // entryA is imported by b, so it is NOT a graph root → no entry qualifies,
    // which also proves the importer back-edge does not crash the walk.
    const flows = buildFlowSkeletons({ cards, usageGraph: g });
    expect(flows).toEqual([]);
  });

  it('cycle within the body does not loop forever (visited guard)', () => {
    // root → x → y → x (y references x); x is reachable only from root's edge,
    // never imported from outside, so root stays a graph root.
    const cards = [
      card('src/root.ts', 'root', { profile: 'sideEffectful', referencedImports: ['x'] }),
      card('src/x.ts', 'x', { profile: 'pure', referencedImports: ['y'] }),
      card('src/y.ts', 'y', { profile: 'pure', referencedImports: ['x'] }),
    ];
    const g = graph([
      { symbol: 'x', sourceFile: 'src/x.ts', importer: 'src/root.ts' },
      { symbol: 'y', sourceFile: 'src/y.ts', importer: 'src/x.ts' },
      { symbol: 'x', sourceFile: 'src/x.ts', importer: 'src/y.ts' },
    ]);

    // x IS imported by y → x has importers → x not a root. root has no importers.
    const flows = buildFlowSkeletons({ cards, usageGraph: g });
    expect(flows).toHaveLength(1);
    // x then y, each once; the y→x back-edge is skipped by the visited guard.
    expect(flows[0]!.steps.map((s) => s.symbol)).toEqual(['x', 'y']);
  });

  it('lowers confidence and flags truncation when the depth cap is hit', () => {
    const cards = [
      card('src/e.ts', 'e', { profile: 'sideEffectful', referencedImports: ['s1'] }),
      card('src/s1.ts', 's1', { profile: 'pure', referencedImports: ['s2'] }),
      card('src/s2.ts', 's2', { profile: 'pure', referencedImports: ['s3'] }),
      card('src/s3.ts', 's3', { profile: 'pure', referencedImports: ['s4'] }),
      card('src/s4.ts', 's4', { profile: 'pure' }),
    ];
    const g = graph([
      { symbol: 's1', sourceFile: 'src/s1.ts', importer: 'src/e.ts' },
      { symbol: 's2', sourceFile: 'src/s2.ts', importer: 'src/s1.ts' },
      { symbol: 's3', sourceFile: 'src/s3.ts', importer: 'src/s2.ts' },
      { symbol: 's4', sourceFile: 'src/s4.ts', importer: 'src/s3.ts' },
    ]);

    const flows = buildFlowSkeletons({ cards, usageGraph: g, caps: { maxDepth: 2 } });

    expect(flows).toHaveLength(1);
    // depth 1 (s1) + depth 2 (s2) collected; s3 (depth 3) is cut.
    expect(flows[0]!.steps.map((s) => s.symbol)).toEqual(['s1', 's2']);
    expect(flows[0]!.confidence).toBe(70);
  });

  it('lowers confidence when a cross-file import resolves ambiguously', () => {
    const cards = [
      card('src/e.ts', 'e', { profile: 'sideEffectful', referencedImports: ['helper'] }),
      card('src/x.ts', 'helper', { profile: 'sideEffectful' }),
      card('src/y.ts', 'helper', { profile: 'sideEffectful' }),
    ];
    // `e` imports `helper` from BOTH x.ts and y.ts → ambiguous.
    const g = graph([
      { symbol: 'helper', sourceFile: 'src/x.ts', importer: 'src/e.ts' },
      { symbol: 'helper', sourceFile: 'src/y.ts', importer: 'src/e.ts' },
    ]);

    const flows = buildFlowSkeletons({ cards, usageGraph: g });

    expect(flows).toHaveLength(1);
    // Sorted-first source (x.ts) is chosen deterministically.
    expect(flows[0]!.steps).toEqual([
      { file: 'src/x.ts', symbol: 'helper', role: 'effect' },
    ]);
    expect(flows[0]!.confidence).toBe(60);
  });

  it('only enrolls graph-root cards with a boundary profile and a resolvable edge', () => {
    const cards = [
      // sideEffectful but imported (not a root) → not an entry.
      card('src/svc.ts', 'service', { profile: 'sideEffectful', referencedImports: ['leaf'] }),
      // pure root → wrong profile → not an entry.
      card('src/pureRoot.ts', 'pureRoot', { profile: 'pure', referencedImports: ['leaf'] }),
      // sideEffectful root but NO resolvable child → skipped.
      card('src/lonely.ts', 'lonely', { profile: 'sideEffectful' }),
      // async root with a resolvable edge → the only entry.
      card('src/ok.ts', 'okEntry', { profile: 'async', referencedImports: ['service'] }),
      card('src/leaf.ts', 'leaf', { profile: 'sideEffectful' }),
    ];
    const g = graph([
      // okEntry imports service → service has an importer (not root); okEntry stays root.
      { symbol: 'service', sourceFile: 'src/svc.ts', importer: 'src/ok.ts' },
      { symbol: 'leaf', sourceFile: 'src/leaf.ts', importer: 'src/svc.ts' },
      { symbol: 'leaf', sourceFile: 'src/leaf.ts', importer: 'src/pureRoot.ts' },
    ]);

    const flows = buildFlowSkeletons({ cards, usageGraph: g });

    expect(flows.map((f) => f.name)).toEqual(['okEntry']);
  });

  it('sees through a public re-export barrel so the re-exported entry still roots', () => {
    // runSchedule is sideEffectful with a real out-edge; the ONLY file that
    // imports it is the public barrel index.ts, which re-exports it
    // (`export { runSchedule } from './dispatcher'`). Barrel-blind, that
    // re-export counts as an importer and runSchedule is wrongly rejected —
    // exactly the train-dispatch flowCount:0 bug.
    const cards = [
      card('src/dispatcher.ts', 'runSchedule', {
        profile: 'sideEffectful',
        referencedImports: ['occupy'],
      }),
      card('src/interlocking.ts', 'occupy', { profile: 'stateful' }),
    ];
    const g = graph(
      [
        { symbol: 'occupy', sourceFile: 'src/interlocking.ts', importer: 'src/dispatcher.ts' },
        // index.ts re-exports runSchedule (recorded as a usage edge like any import).
        { symbol: 'runSchedule', sourceFile: 'src/dispatcher.ts', importer: 'src/index.ts' },
      ],
      new Map([['src/index.ts', new Set(['runSchedule'])]]),
    );

    const flows = buildFlowSkeletons({ cards, usageGraph: g });

    expect(flows.map((f) => f.name)).toEqual(['runSchedule']);
    expect(flows[0]!.entry.file).toBe('src/dispatcher.ts');
    expect(flows[0]!.effects).toEqual([
      { file: 'src/interlocking.ts', symbol: 'occupy', kind: 'state_mutation' },
    ]);
  });

  it('still rejects an entry that has a real consumer beyond the barrel', () => {
    // runSchedule is BOTH re-exported by index.ts AND imported+used by worker.ts.
    // The barrel is transparent, but worker is a real consumer → runSchedule is
    // not a root. worker itself (async, unimported) is the entry.
    const cards = [
      card('src/dispatcher.ts', 'runSchedule', {
        profile: 'sideEffectful',
        referencedImports: ['occupy'],
      }),
      card('src/interlocking.ts', 'occupy', { profile: 'stateful' }),
      card('src/worker.ts', 'worker', { profile: 'async', referencedImports: ['runSchedule'] }),
    ];
    const g = graph(
      [
        { symbol: 'occupy', sourceFile: 'src/interlocking.ts', importer: 'src/dispatcher.ts' },
        { symbol: 'runSchedule', sourceFile: 'src/dispatcher.ts', importer: 'src/index.ts' },
        { symbol: 'runSchedule', sourceFile: 'src/dispatcher.ts', importer: 'src/worker.ts' },
      ],
      new Map([['src/index.ts', new Set(['runSchedule'])]]),
    );

    const flows = buildFlowSkeletons({ cards, usageGraph: g });
    expect(flows.map((f) => f.name)).toEqual(['worker']);
  });

  it('returns deterministic, id-sorted output and respects maxFlows', () => {
    const cards = [
      card('src/z.ts', 'zEntry', { profile: 'sideEffectful', referencedImports: ['leaf'] }),
      card('src/a.ts', 'aEntry', { profile: 'sideEffectful', referencedImports: ['leaf'] }),
      card('src/leaf.ts', 'leaf', { profile: 'sideEffectful' }),
    ];
    const g = graph([
      { symbol: 'leaf', sourceFile: 'src/leaf.ts', importer: 'src/z.ts' },
      { symbol: 'leaf', sourceFile: 'src/leaf.ts', importer: 'src/a.ts' },
    ]);

    const all = buildFlowSkeletons({ cards, usageGraph: g });
    expect(all.map((f) => f.id)).toEqual([
      'flow:src/a.ts::aEntry',
      'flow:src/z.ts::zEntry',
    ]);

    const capped = buildFlowSkeletons({ cards, usageGraph: g, caps: { maxFlows: 1 } });
    expect(capped.map((f) => f.id)).toEqual(['flow:src/a.ts::aEntry']);
  });

  it('is a no-op on an empty card set', () => {
    expect(buildFlowSkeletons({ cards: [], usageGraph: graph([]) })).toEqual([]);
  });
});
