// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFlowArtifact, flowArtifactPath } from './flow-writer.js';
import { UserFlowArtifactSchema, type UserFlow } from '../../schemas/user-flow.js';

function flow(overrides: Partial<UserFlow> = {}): UserFlow {
  return {
    id: 'flow:src/a.ts::entry',
    name: 'entry',
    finality: 'does a thing',
    entry: { file: 'src/a.ts', symbol: 'entry', kind: 'side_effect' },
    steps: [{ file: 'src/b.ts', symbol: 'step', role: 'transform' }],
    effects: [{ file: 'src/c.ts', symbol: 'write', kind: 'side_effect' }],
    confidence: 100,
    unwired: false,
    ...overrides,
  };
}

describe('writeFlowArtifact', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anatoly-flows-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the artifact to the canonical state path', () => {
    const path = writeFlowArtifact(root, [flow()]);
    expect(path).toBe(flowArtifactPath(root));
    expect(path).toContain(join('.anatoly', 'state', 'internal-flows', 'flows.json'));
    expect(existsSync(path)).toBe(true);
  });

  it('round-trips through the schema with a correct flowCount', () => {
    const flows = [flow(), flow({ id: 'flow:src/z.ts::other', name: 'other' })];
    const path = writeFlowArtifact(root, flows);

    const parsed = UserFlowArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
    expect(parsed.version).toBe(1);
    expect(parsed.flowCount).toBe(2);
    expect(parsed.flows).toEqual(flows);
  });

  it('overwrites a prior artifact in place (re-derived, never appended)', () => {
    writeFlowArtifact(root, [flow(), flow({ id: 'flow:src/z.ts::other' })]);
    const path = writeFlowArtifact(root, [flow({ id: 'flow:src/only.ts::one' })]);

    const parsed = UserFlowArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
    expect(parsed.flowCount).toBe(1);
    expect(parsed.flows[0]!.id).toBe('flow:src/only.ts::one');
  });

  it('writes a valid empty artifact for zero flows', () => {
    const path = writeFlowArtifact(root, []);
    const parsed = UserFlowArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
    expect(parsed.flowCount).toBe(0);
    expect(parsed.flows).toEqual([]);
  });
});
