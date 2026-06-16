// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFlowDocPhase } from './flow-doc.js';
import { writeFlowArtifact, flowArtifactPath, flowDocPagePath } from '../../flows/index.js';
import type { DocExecutor } from '../../documentation/index.js';
import type { UserFlow } from '../../../schemas/user-flow.js';
import type { RunContext } from '../../../commands/run.js';

// Minimal pipeline-state spy capturing the (task, detail) signals.
function makeState() {
  return {
    startTask: vi.fn(),
    completeTask: vi.fn(),
  };
}

// Hermetic ctx: only the fields runFlowDocPhase + recordDocGenerationCost read.
function ctx(root: string, flows: boolean, state = makeState()): RunContext {
  return {
    flows,
    projectRoot: root,
    pipelineState: state,
    totalCostUsd: 0,
    providerStats: { anthropic: { calls: 0, costUsd: 0 } },
    phaseStats: {},
  } as unknown as RunContext;
}

function flow(overrides: Partial<UserFlow> = {}): UserFlow {
  return {
    id: 'flow:src/api.ts::serve',
    name: 'serve',
    finality: 'serve',
    entry: { file: 'src/api.ts', symbol: 'serve', kind: 'side_effect' },
    steps: [{ file: 'src/db.ts', symbol: 'write', role: 'effect' }],
    effects: [{ file: 'src/db.ts', symbol: 'write', kind: 'side_effect' }],
    confidence: 80,
    unwired: false,
    ...overrides,
  };
}

/** Executor that returns synthetic markdown — never a real LLM call. */
function fakeExecutor(text = '# User Flows\n\nThe flow enters at serve.\n'): DocExecutor {
  return vi.fn(async () => ({ text, costUsd: 0 })) as unknown as DocExecutor;
}

describe('runFlowDocPhase', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anatoly-flow-doc-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op (no page, no task signal, no executor call) when disabled', async () => {
    const state = makeState();
    writeFlowArtifact(root, [flow()]);
    const exec = fakeExecutor();
    await runFlowDocPhase(ctx(root, false, state), { executor: exec });

    expect(existsSync(flowDocPagePath(root))).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(state.startTask).not.toHaveBeenCalled();
    expect(state.completeTask).not.toHaveBeenCalled();
  });

  it('skips (no executor call) when the flows artifact is absent', async () => {
    const state = makeState();
    const exec = fakeExecutor();
    await runFlowDocPhase(ctx(root, true, state), { executor: exec });

    expect(existsSync(flowDocPagePath(root))).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(state.completeTask).toHaveBeenCalledWith('flow-doc', 'skipped (no flows artifact)');
  });

  it('skips on an empty flows artifact (bench-neutral no-op)', async () => {
    const state = makeState();
    writeFlowArtifact(root, []);
    const exec = fakeExecutor();
    await runFlowDocPhase(ctx(root, true, state), { executor: exec });

    expect(existsSync(flowDocPagePath(root))).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(state.completeTask).toHaveBeenCalledWith('flow-doc', 'no flows');
  });

  it('skips on an unreadable artifact', async () => {
    const state = makeState();
    const artifactPath = flowArtifactPath(root);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, 'not json', 'utf-8');
    const exec = fakeExecutor();
    await runFlowDocPhase(ctx(root, true, state), { executor: exec });

    expect(existsSync(flowDocPagePath(root))).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(state.completeTask).toHaveBeenCalledWith('flow-doc', 'skipped (bad artifact)');
  });

  it('narrates the page on the happy path, recording the cost', async () => {
    const state = makeState();
    writeFlowArtifact(root, [flow()]);
    const exec = fakeExecutor();
    const c = ctx(root, true, state);
    await runFlowDocPhase(c, { executor: exec });

    expect(exec).toHaveBeenCalledTimes(1);
    // The executor was handed the registered flow system prompt + grounding.
    const prompt = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      system: string; user: string; model: string;
    };
    expect(prompt.system).toContain('User Flows');
    expect(prompt.user).toContain('flow:src/api.ts::serve');
    expect(prompt.model).toBe('sonnet');

    const page = readFileSync(flowDocPagePath(root), 'utf-8');
    expect(page).toContain('# User Flows');
    expect(state.completeTask).toHaveBeenCalledWith('flow-doc', 'page generated');
    // Cost folded into the flow-doc phase bucket.
    expect(c.phaseStats['flow-doc']?.calls).toBe(1);
  });

  it('strips any preamble before the first markdown heading', async () => {
    const state = makeState();
    writeFlowArtifact(root, [flow()]);
    const exec = fakeExecutor('Here is the documentation:\n\n# User Flows\n\nBody.\n');
    await runFlowDocPhase(ctx(root, true, state), { executor: exec });

    const page = readFileSync(flowDocPagePath(root), 'utf-8');
    expect(page.startsWith('# User Flows')).toBe(true);
    expect(page).not.toContain('Here is the documentation');
  });

  it('never overwrites an existing page (ratification preserved)', async () => {
    const state = makeState();
    writeFlowArtifact(root, [flow()]);
    const pagePath = flowDocPagePath(root);
    mkdirSync(dirname(pagePath), { recursive: true });
    writeFileSync(pagePath, '# User Flows\n\nHUMAN-EDITED.\n', 'utf-8');
    const exec = fakeExecutor();
    await runFlowDocPhase(ctx(root, true, state), { executor: exec });

    expect(exec).not.toHaveBeenCalled();
    expect(readFileSync(pagePath, 'utf-8')).toContain('HUMAN-EDITED');
    expect(state.completeTask).toHaveBeenCalledWith('flow-doc', 'page exists');
  });
});
