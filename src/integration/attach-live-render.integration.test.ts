// SPDX-License-Identifier: AGPL-3.0-only
// Story 53.5 — attach live render integration test

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tailNdjson } from '../core/ndjson-tail.js';
import { createAttachEventHandler } from '../commands/attach.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let tmpRoot: string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ndjsonLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

beforeEach(() => {
  tmpRoot = join(tmpdir(), `attach-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(tmpRoot, '.anatoly', 'runs', 'test-run'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  Event handler unit tests                                          */
/* ------------------------------------------------------------------ */

describe('createAttachEventHandler', () => {
  it('tracks phase transitions', () => {
    const { handleEvent, state } = createAttachEventHandler();

    handleEvent({ event: 'phase_start', phase: 'scan' });
    expect(state.currentPhase).toBe('scan');

    handleEvent({ event: 'phase_end', phase: 'scan', durationMs: 1000 });
    expect(state.currentPhase).toBe('');
  });

  it('counts file_review_end events and tracks findings', () => {
    const { handleEvent, state } = createAttachEventHandler();

    handleEvent({ event: 'file_review_end', file: 'src/a.ts', verdict: 'CLEAN' });
    handleEvent({ event: 'file_review_end', file: 'src/b.ts', verdict: 'NEEDS_REVIEW' });
    handleEvent({ event: 'file_review_end', file: 'src/c.ts', verdict: 'ERROR' });

    expect(state.reviewedFiles).toBe(3);
    expect(state.findings).toHaveLength(3);
    expect(state.findings[0]).toEqual({ file: 'src/a.ts', verdict: 'CLEAN' });
    expect(state.findings[2]).toEqual({ file: 'src/c.ts', verdict: 'ERROR' });
  });

  it('handles estimate_total event for progress bar', () => {
    const { handleEvent, state } = createAttachEventHandler();

    handleEvent({ event: 'estimate_total', total: 42 });
    expect(state.totalFiles).toBe(42);
  });

  it('ignores unknown events without error', () => {
    const { handleEvent, state } = createAttachEventHandler();

    handleEvent({ event: 'unknown_event', data: 'foo' });
    handleEvent({ msg: 'no event field' });
    handleEvent(null);
    handleEvent('string');

    expect(state.reviewedFiles).toBe(0);
    expect(state.currentPhase).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/*  End-to-end: tailNdjson + event handler                            */
/* ------------------------------------------------------------------ */

describe('attach live render — tail + handler integration', () => {
  it('processes incrementally written ndjson events', async () => {
    const ndjsonPath = join(tmpRoot, '.anatoly', 'runs', 'test-run', 'anatoly.ndjson');
    writeFileSync(ndjsonPath, '');

    const { handleEvent, state } = createAttachEventHandler();
    const errors: Error[] = [];

    const handle = tailNdjson(ndjsonPath, {
      fromStart: true,
      onEvent: handleEvent,
      onError: (err) => errors.push(err),
    });

    // Simulate run writing events incrementally
    appendFileSync(ndjsonPath, ndjsonLine({ event: 'phase_start', phase: 'scan' }));
    appendFileSync(ndjsonPath, ndjsonLine({ event: 'phase_end', phase: 'scan', durationMs: 500 }));
    appendFileSync(ndjsonPath, ndjsonLine({ event: 'phase_start', phase: 'review' }));
    await sleep(200);

    expect(state.currentPhase).toBe('review');

    // Write file review events
    appendFileSync(ndjsonPath, ndjsonLine({ event: 'estimate_total', total: 5 }));
    for (let i = 1; i <= 5; i++) {
      appendFileSync(ndjsonPath, ndjsonLine({ event: 'file_review_end', file: `src/file${i}.ts`, verdict: 'CLEAN' }));
    }
    await sleep(200);

    expect(state.reviewedFiles).toBe(5);
    expect(state.totalFiles).toBe(5);
    expect(state.findings).toHaveLength(5);

    appendFileSync(ndjsonPath, ndjsonLine({ event: 'phase_end', phase: 'review', durationMs: 3000 }));
    await sleep(150);

    handle.stop();

    expect(errors).toHaveLength(0);
    expect(state.currentPhase).toBe('');
  });

  it('--from-start replays existing events', async () => {
    const ndjsonPath = join(tmpRoot, '.anatoly', 'runs', 'test-run', 'anatoly.ndjson');

    // Pre-populate with history
    let content = '';
    content += ndjsonLine({ event: 'phase_start', phase: 'scan' });
    content += ndjsonLine({ event: 'phase_end', phase: 'scan', durationMs: 100 });
    content += ndjsonLine({ event: 'phase_start', phase: 'review' });
    for (let i = 1; i <= 3; i++) {
      content += ndjsonLine({ event: 'file_review_end', file: `src/h${i}.ts`, verdict: 'CLEAN' });
    }
    writeFileSync(ndjsonPath, content);

    const { handleEvent, state } = createAttachEventHandler();

    const handle = tailNdjson(ndjsonPath, {
      fromStart: true,
      onEvent: handleEvent,
      onError: () => {},
    });

    await sleep(150);
    handle.stop();

    // Should have replayed all existing events
    expect(state.reviewedFiles).toBe(3);
    expect(state.currentPhase).toBe('review');
  });

  it('performance: replays 500 events under 1000ms', async () => {
    const ndjsonPath = join(tmpRoot, '.anatoly', 'runs', 'test-run', 'anatoly.ndjson');

    // Write 500 events
    let content = '';
    content += ndjsonLine({ event: 'phase_start', phase: 'review' });
    content += ndjsonLine({ event: 'estimate_total', total: 498 });
    for (let i = 1; i <= 498; i++) {
      content += ndjsonLine({ event: 'file_review_end', file: `src/file${i}.ts`, verdict: 'CLEAN' });
    }
    content += ndjsonLine({ event: 'phase_end', phase: 'review', durationMs: 60000 });
    writeFileSync(ndjsonPath, content);

    const { handleEvent, state } = createAttachEventHandler();
    const start = Date.now();

    const handle = tailNdjson(ndjsonPath, {
      fromStart: true,
      onEvent: handleEvent,
      onError: () => {},
    });

    await sleep(200);
    handle.stop();
    const elapsed = Date.now() - start;

    expect(state.reviewedFiles).toBe(498);
    expect(elapsed).toBeLessThan(1000); // NFR3 with 2x margin
  });
});
