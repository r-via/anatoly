// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCommandObservability } from './command-observability.js';
import { getLogContext } from '../../utils/log-context.js';
import { getActiveSinkPath } from '../../utils/llm-calls-sink.js';
import { _resetLogger } from '../../utils/logger.js';
import { conversationsDir, runEventLogPath, costsLedgerPath } from '../../utils/run-layout.js';

describe('withCommandObservability', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cmd-obs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _resetLogger();
  });

  it('opens the phase/runId scope, the sink, and the file logger under commands/<cmd>/', async () => {
    let dir = '';
    let ctxPhase: string | undefined;
    let ctxRunId: string | undefined;
    let convDir = '';
    let sinkPath: string | undefined;

    const result = await withCommandObservability(root, 'scope', async ({ runDir, conversationDir }) => {
      dir = runDir;
      convDir = conversationDir;
      const ctx = getLogContext();
      ctxPhase = ctx?.phase;
      ctxRunId = ctx?.runId;
      sinkPath = getActiveSinkPath();
      return 'ok';
    });

    expect(result).toBe('ok');
    // phase is what buildDumpSlug needs; without it conversation dumps never write.
    expect(ctxPhase).toBe('scope');
    expect(ctxRunId).toBeTruthy();
    expect(dir).toContain(join('.anatoly', 'commands', 'scope'));
    expect(convDir).toBe(conversationsDir(dir));
    expect(sinkPath).toBe(costsLedgerPath(dir));
    expect(existsSync(runEventLogPath(dir))).toBe(true);
  });

  it('prunes old timestamped dirs beyond keep before creating the new one', async () => {
    const base = join(root, '.anatoly', 'commands', 'refresh');
    mkdirSync(base, { recursive: true });
    for (const ts of ['2020-01-01T00-00-00-000Z', '2020-01-02T00-00-00-000Z', '2020-01-03T00-00-00-000Z']) {
      mkdirSync(join(base, ts), { recursive: true });
    }
    await withCommandObservability(root, 'refresh', async () => undefined, { keep: 2 });
    // prune(keep-1=1) keeps the newest 1 of the 3 old dirs, then the new dir is added → 2.
    expect(readdirSync(base).filter((n) => n.startsWith('20')).length).toBe(2);
  });
});
