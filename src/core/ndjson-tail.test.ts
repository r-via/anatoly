// SPDX-License-Identifier: AGPL-3.0-only
// Story 53.5 — ndjson-tail unit tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tailNdjson } from './ndjson-tail.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let tmpDir: string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ndjson-tail-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  fromStart: true — reads existing + new events                     */
/* ------------------------------------------------------------------ */

describe('tailNdjson', () => {
  it('reads existing events and new events with fromStart: true', async () => {
    const filePath = join(tmpDir, 'test.ndjson');
    // Write 3 events before starting tail
    const events = [
      { event: 'phase_start', phase: 'scan' },
      { event: 'phase_end', phase: 'scan' },
      { event: 'file_review_end', file: 'a.ts' },
    ];
    writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const received: unknown[] = [];
    const errors: Error[] = [];

    const handle = tailNdjson(filePath, {
      fromStart: true,
      onEvent: (ev) => received.push(ev),
      onError: (err) => errors.push(err),
    });

    await sleep(150);

    // Write 2 more events
    appendFileSync(filePath, JSON.stringify({ event: 'file_review_end', file: 'b.ts' }) + '\n');
    appendFileSync(filePath, JSON.stringify({ event: 'phase_end', phase: 'review' }) + '\n');

    await sleep(150);

    handle.stop();

    expect(errors).toHaveLength(0);
    expect(received).toHaveLength(5);
    expect(received[0]).toEqual({ event: 'phase_start', phase: 'scan' });
    expect(received[4]).toEqual({ event: 'phase_end', phase: 'review' });
  });

  it('handles partial lines correctly', async () => {
    const filePath = join(tmpDir, 'partial.ndjson');
    writeFileSync(filePath, '');

    const received: unknown[] = [];
    const handle = tailNdjson(filePath, {
      fromStart: true,
      onEvent: (ev) => received.push(ev),
      onError: () => {},
    });

    await sleep(100);

    // Write a partial line (no newline)
    appendFileSync(filePath, '{"event":"partial"');
    await sleep(150);
    expect(received).toHaveLength(0); // Not yet complete

    // Complete the line and write another
    appendFileSync(filePath, '}\n{"event":"complete"}\n');
    await sleep(150);

    handle.stop();

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ event: 'partial' });
    expect(received[1]).toEqual({ event: 'complete' });
  });

  it('tail-only mode skips existing content', async () => {
    const filePath = join(tmpDir, 'tail-only.ndjson');
    // Pre-fill with existing events
    writeFileSync(filePath, '{"event":"old1"}\n{"event":"old2"}\n');

    const received: unknown[] = [];
    const handle = tailNdjson(filePath, {
      fromStart: false,
      onEvent: (ev) => received.push(ev),
      onError: () => {},
    });

    await sleep(150);

    // Only new events should be received
    appendFileSync(filePath, '{"event":"new1"}\n');
    await sleep(150);

    handle.stop();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ event: 'new1' });
  });

  it('handles file that does not exist yet', async () => {
    const filePath = join(tmpDir, 'does-not-exist.ndjson');

    const received: unknown[] = [];
    const handle = tailNdjson(filePath, {
      fromStart: true,
      onEvent: (ev) => received.push(ev),
      onError: () => {},
    });

    await sleep(100);

    // Create file and write
    writeFileSync(filePath, '{"event":"late"}\n');
    await sleep(300);

    handle.stop();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ event: 'late' });
  });

  it('skips invalid JSON lines without crashing', async () => {
    const filePath = join(tmpDir, 'invalid.ndjson');
    writeFileSync(filePath, 'not json\n{"event":"valid"}\n');

    const received: unknown[] = [];
    const errors: Error[] = [];
    const handle = tailNdjson(filePath, {
      fromStart: true,
      onEvent: (ev) => received.push(ev),
      onError: (err) => errors.push(err),
    });

    await sleep(150);
    handle.stop();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ event: 'valid' });
    // Invalid lines should be reported as errors
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('stop() prevents further events from being emitted', async () => {
    const filePath = join(tmpDir, 'stop.ndjson');
    writeFileSync(filePath, '{"event":"before"}\n');

    const received: unknown[] = [];
    const handle = tailNdjson(filePath, {
      fromStart: true,
      onEvent: (ev) => received.push(ev),
      onError: () => {},
    });

    await sleep(150);
    handle.stop();

    // Write after stop
    appendFileSync(filePath, '{"event":"after"}\n');
    await sleep(150);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ event: 'before' });
  });
});
