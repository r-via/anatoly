// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFlowsPhase } from './flows.js';
import { flowArtifactPath } from '../../flows/index.js';
import { UserFlowArtifactSchema } from '../../../schemas/user-flow.js';
import type { RunContext } from '../../../commands/run.js';
import type { Handoff, RagContext } from '../handoff.js';
import type { UsageGraph } from '../../scanning/usage-graph.js';
import type { FunctionCard } from '../../../rag/types.js';

// Minimal pipeline-state spy capturing the (task, detail) completions.
function makeState() {
  return {
    startTask: vi.fn(),
    completeTask: vi.fn(),
  };
}

function ctx(root: string, flows: boolean, state = makeState()): RunContext {
  return { flows, projectRoot: root, pipelineState: state } as unknown as RunContext;
}

function rag(ragEnabled: boolean, cards?: FunctionCard[]): RagContext {
  const vectorStore = cards
    ? ({ listAll: async () => cards } as unknown as RagContext['vectorStore'])
    : undefined;
  return { ragEnabled, vectorStore } as RagContext;
}

function handoff(usageGraph?: UsageGraph): Handoff {
  return { usageGraph } as unknown as Handoff;
}

const EMPTY_GRAPH: UsageGraph = {
  usages: new Map(),
  typeOnlyUsages: new Map(),
  intraFileRefs: new Map(),
  noImportFiles: new Set(),
};

function entryCard(): FunctionCard {
  return {
    id: 'src/api.ts#serve',
    filePath: 'src/api.ts',
    name: 'serve',
    signature: 'function serve()',
    behavioralProfile: 'sideEffectful',
    complexityScore: 1,
    calledInternals: [],
    referencedImports: ['write'],
    lastIndexed: '2026-01-01T00:00:00.000Z',
  };
}

function effectCard(): FunctionCard {
  return {
    id: 'src/db.ts#write',
    filePath: 'src/db.ts',
    name: 'write',
    signature: 'function write()',
    behavioralProfile: 'sideEffectful',
    complexityScore: 1,
    calledInternals: [],
    referencedImports: [],
    lastIndexed: '2026-01-01T00:00:00.000Z',
  };
}

describe('runFlowsPhase', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anatoly-flows-phase-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op (no artifact, no task signal) when disabled', async () => {
    const state = makeState();
    await runFlowsPhase(ctx(root, false, state), handoff(EMPTY_GRAPH), rag(true, [entryCard()]));
    expect(existsSync(flowArtifactPath(root))).toBe(false);
    expect(state.startTask).not.toHaveBeenCalled();
    expect(state.completeTask).not.toHaveBeenCalled();
  });

  it('skips when RAG is inactive', async () => {
    const state = makeState();
    await runFlowsPhase(ctx(root, true, state), handoff(EMPTY_GRAPH), rag(false));
    expect(existsSync(flowArtifactPath(root))).toBe(false);
    expect(state.completeTask).toHaveBeenCalledWith('flows', 'skipped (rag inactive)');
  });

  it('skips when there is no usage graph', async () => {
    const state = makeState();
    await runFlowsPhase(ctx(root, true, state), handoff(undefined), rag(true, [entryCard()]));
    expect(existsSync(flowArtifactPath(root))).toBe(false);
    expect(state.completeTask).toHaveBeenCalledWith('flows', 'skipped (no usage graph)');
  });

  it('writes an empty artifact and reports no cards on an empty store', async () => {
    const state = makeState();
    await runFlowsPhase(ctx(root, true, state), handoff(EMPTY_GRAPH), rag(true, []));
    const parsed = UserFlowArtifactSchema.parse(JSON.parse(readFileSync(flowArtifactPath(root), 'utf-8')));
    expect(parsed.flowCount).toBe(0);
    expect(state.completeTask).toHaveBeenCalledWith('flows', 'no cards');
  });

  it('models flows and writes the artifact on the happy path', async () => {
    const state = makeState();
    const graph: UsageGraph = {
      usages: new Map([['write::src/db.ts', new Set(['src/api.ts'])]]),
      typeOnlyUsages: new Map(),
      intraFileRefs: new Map(),
      noImportFiles: new Set(),
    };
    await runFlowsPhase(
      ctx(root, true, state),
      handoff(graph),
      rag(true, [entryCard(), effectCard()]),
    );

    const parsed = UserFlowArtifactSchema.parse(JSON.parse(readFileSync(flowArtifactPath(root), 'utf-8')));
    expect(parsed.flowCount).toBe(1);
    expect(parsed.flows[0]!.id).toBe('flow:src/api.ts::serve');
    expect(parsed.flows[0]!.effects).toHaveLength(1);
    expect(state.completeTask).toHaveBeenCalledWith('flows', '1 flow(s)');
  });
});
