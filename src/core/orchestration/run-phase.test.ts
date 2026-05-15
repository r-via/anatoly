// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPhase, CANONICAL_PHASES, DuplicatePhaseError, type RunPhaseContext } from './run-phase.js';
import { getLogContext } from '../../utils/log-context.js';
import * as loggerModule from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'debug',
  };
}

function createMockCtx(overrides?: Partial<RunPhaseContext>): RunPhaseContext {
  return {
    runId: 'test-run-001',
    startTime: Date.now() - 1000,
    timeline: [],
    phaseDurations: {},
    runLog: {
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as RunPhaseContext['runLog'],
    pipelineState: {
      setPhase: vi.fn(),
    } as unknown as RunPhaseContext['pipelineState'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CANONICAL_PHASES', () => {
  it('should list exactly 11 phases in the correct order', () => {
    expect(CANONICAL_PHASES).toEqual([
      'scan',
      'estimate',
      'triage',
      'bootstrap-doc',
      'doc-conflict-bootstrap',
      'rag-index',
      'internal-docs',
      'doc-conflict-update',
      'review',
      'refinement',
      'report',
    ]);
    expect(CANONICAL_PHASES).toHaveLength(11);
  });

  it('should be readonly (frozen)', () => {
    expect(Object.isFrozen(CANONICAL_PHASES)).toBe(true);
  });
});

describe('runPhase', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    vi.spyOn(loggerModule, 'getLogger').mockReturnValue(mockLogger as unknown as loggerModule.Logger);
  });

  // -----------------------------------------------------------------------
  // Success path — all 8 effects
  // -----------------------------------------------------------------------

  describe('success path — all 8 effects fire', () => {
    it('should return the fn result', async () => {
      const ctx = createMockCtx();
      const result = await runPhase(ctx, 'review', async () => 'done');
      expect(result).toBe('done');
    });

    it('(a) should push phase_start to timeline', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'review', async () => undefined);

      const startEvent = ctx.timeline.find((e) => e.event === 'phase_start');
      expect(startEvent).toMatchObject({ event: 'phase_start', phase: 'review' });
      expect(typeof startEvent!.t).toBe('number');
    });

    it('(b) should call getLogger().info with phase_start', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'review', async () => undefined);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'phase_start', phase: 'review', runId: 'test-run-001' }),
        'phase started',
      );
    });

    it('(c) should call ctx.runLog.info with phase_start', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'review', async () => undefined);

      expect(ctx.runLog!.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'phase_start', phase: 'review', runId: 'test-run-001' }),
        'phase started',
      );
    });

    it('(d) should call ctx.pipelineState.setPhase', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'review', async () => undefined);

      expect(ctx.pipelineState!.setPhase).toHaveBeenCalledWith('review');
    });

    it('(f) should assign phaseDurations[name]', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'review', async () => undefined);

      expect(typeof ctx.phaseDurations['review']).toBe('number');
      expect(ctx.phaseDurations['review']).toBeGreaterThanOrEqual(0);
    });

    it('(g) should push phase_end to timeline with durationMs', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'review', async () => undefined);

      const endEvent = ctx.timeline.find((e) => e.event === 'phase_end');
      expect(endEvent).toMatchObject({ event: 'phase_end', phase: 'review' });
      expect(typeof endEvent!.durationMs).toBe('number');
      expect(typeof endEvent!.t).toBe('number');
    });

    it('(h) should call getLogger().info and runLog.info with phase_end', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'review', async () => undefined);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'phase_end', phase: 'review', runId: 'test-run-001' }),
        'phase ended',
      );
      expect(ctx.runLog!.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'phase_end', phase: 'review', runId: 'test-run-001' }),
        'phase ended',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Error path — all effects fire with error context attached
  // -----------------------------------------------------------------------

  describe('error path — all effects fire with error context', () => {
    it('should rethrow the error', async () => {
      const ctx = createMockCtx();
      await expect(
        runPhase(ctx, 'scan', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('should attach phase to the error object', async () => {
      const ctx = createMockCtx();
      const err = new Error('boom');

      try {
        await runPhase(ctx, 'scan', async () => {
          throw err;
        });
      } catch {
        // expected
      }

      expect((err as Error & { phase: string }).phase).toBe('scan');
    });

    it('should still record phaseDurations on error', async () => {
      const ctx = createMockCtx();

      try {
        await runPhase(ctx, 'scan', async () => {
          throw new Error('fail');
        });
      } catch {
        // expected
      }

      expect(typeof ctx.phaseDurations['scan']).toBe('number');
      expect(ctx.phaseDurations['scan']).toBeGreaterThanOrEqual(0);
    });

    it('should push phase_end to timeline on error', async () => {
      const ctx = createMockCtx();

      try {
        await runPhase(ctx, 'scan', async () => {
          throw new Error('fail');
        });
      } catch {
        // expected
      }

      const endEvent = ctx.timeline.find((e) => e.event === 'phase_end');
      expect(endEvent).toMatchObject({ event: 'phase_end', phase: 'scan' });
      expect(typeof endEvent!.durationMs).toBe('number');
    });

    it('should call getLogger().error with error context', async () => {
      const ctx = createMockCtx();

      try {
        await runPhase(ctx, 'scan', async () => {
          throw new Error('fail');
        });
      } catch {
        // expected
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'scan', runId: 'test-run-001' }),
        expect.stringContaining('scan'),
      );
    });

    it('should emit symmetric phase_end logs even on error', async () => {
      const ctx = createMockCtx();

      try {
        await runPhase(ctx, 'scan', async () => {
          throw new Error('fail');
        });
      } catch {
        // expected
      }

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'phase_end', phase: 'scan' }),
        'phase ended',
      );
      expect(ctx.runLog!.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'phase_end', phase: 'scan' }),
        'phase ended',
      );
    });
  });

  // -----------------------------------------------------------------------
  // Duplicate phase name throws
  // -----------------------------------------------------------------------

  describe('duplicate phase name detection', () => {
    it('should throw DuplicatePhaseError on second invocation of same phase', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'review', async () => 'first');

      await expect(runPhase(ctx, 'review', async () => 'second')).rejects.toThrow(DuplicatePhaseError);
    });

    it('should include phase name and runId in the error message', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'review', async () => 'first');

      await expect(runPhase(ctx, 'review', async () => 'second')).rejects.toThrow(
        /phase "review" already executed in run test-run-001/,
      );
    });

    it('should allow different phase names on the same ctx', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'scan', async () => 'a');
      await runPhase(ctx, 'estimate', async () => 'b');

      expect(ctx.phaseDurations).toHaveProperty('scan');
      expect(ctx.phaseDurations).toHaveProperty('estimate');
    });

    it('should isolate tracking between different ctx objects', async () => {
      const ctx1 = createMockCtx();
      const ctx2 = createMockCtx();

      await runPhase(ctx1, 'review', async () => 'first');
      // Same phase name on different ctx — should succeed
      await runPhase(ctx2, 'review', async () => 'second');
    });
  });

  // -----------------------------------------------------------------------
  // phaseDurations uses = not +=
  // -----------------------------------------------------------------------

  describe('phaseDurations uses = not +=', () => {
    it('should overwrite a pre-existing stale value', async () => {
      const ctx = createMockCtx();
      // Pre-set a stale value to verify overwrite, not accumulation
      ctx.phaseDurations['scan'] = 9999;

      await runPhase(ctx, 'scan', async () => {
        await new Promise((r) => setTimeout(r, 5));
      });

      // With `=`, the value is the actual duration (~5ms), NOT 9999 + 5ms
      expect(ctx.phaseDurations['scan']).toBeLessThan(9999);
      expect(ctx.phaseDurations['scan']).toBeGreaterThanOrEqual(0);
    });

    it('should keep independent durations for consecutive phases', async () => {
      const ctx = createMockCtx();

      await runPhase(ctx, 'scan', async () => {
        await new Promise((r) => setTimeout(r, 5));
      });

      const scanDuration = ctx.phaseDurations['scan'];

      await runPhase(ctx, 'estimate', async () => {
        await new Promise((r) => setTimeout(r, 5));
      });

      // scan duration unchanged after second runPhase call
      expect(ctx.phaseDurations['scan']).toBe(scanDuration);
      // estimate has its own independent duration
      expect(typeof ctx.phaseDurations['estimate']).toBe('number');
      expect(ctx.phaseDurations['estimate']).toBeGreaterThanOrEqual(0);
    });
  });

  // -----------------------------------------------------------------------
  // AsyncLocalStorage scope
  // -----------------------------------------------------------------------

  describe('AsyncLocalStorage scope', () => {
    it('should make phase visible to nested getLogContext() calls inside fn', async () => {
      const ctx = createMockCtx();
      let capturedContext: ReturnType<typeof getLogContext>;

      await runPhase(ctx, 'refinement', async () => {
        capturedContext = getLogContext();
      });

      expect(capturedContext!).toBeDefined();
      expect(capturedContext!.phase).toBe('refinement');
    });

    it('should not leak phase context after runPhase completes', async () => {
      const ctx = createMockCtx();
      await runPhase(ctx, 'report', async () => undefined);

      // Outside runPhase, no phase context should be active
      const outerCtx = getLogContext();
      expect(outerCtx?.phase).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Optional fields
  // -----------------------------------------------------------------------

  describe('optional fields', () => {
    it('should work without runLog', async () => {
      const ctx = createMockCtx({ runLog: undefined });
      const result = await runPhase(ctx, 'estimate', async () => 42);
      expect(result).toBe(42);
      expect(ctx.phaseDurations['estimate']).toBeGreaterThanOrEqual(0);
    });

    it('should work without pipelineState', async () => {
      const ctx = createMockCtx({ pipelineState: undefined });
      const result = await runPhase(ctx, 'triage', async () => 'ok');
      expect(result).toBe('ok');
    });
  });

  // -----------------------------------------------------------------------
  // Orchestrator fail-fast seam (ctx.fatalError)
  // -----------------------------------------------------------------------

  describe('fatal-stop seam', () => {
    it('rethrows ctx.fatalError when fn returns normally but a fatal was latched', async () => {
      const fatal = new Error('auth failed');
      const ctx = createMockCtx();
      await expect(
        runPhase(ctx, 'review', async () => {
          // Simulate a worker latching a run-fatal error while the phase
          // itself returns normally (errors isolated per file/page).
          ctx.fatalError = fatal;
          return 'phase-returned-ok';
        }),
      ).rejects.toBe(fatal);
    });

    it('prefers the latched fatal over an incidental error in the catch path', async () => {
      const fatal = new Error('auth failed');
      const ctx = createMockCtx();
      await expect(
        runPhase(ctx, 'review', async () => {
          ctx.fatalError = fatal;
          // An abort triggered by the fatal-stop surfaces here; the more
          // actionable latched error must win.
          throw new Error('aborted');
        }),
      ).rejects.toBe(fatal);
    });

    it('does not interfere when no fatal is latched', async () => {
      const ctx = createMockCtx();
      const result = await runPhase(ctx, 'review', async () => 'clean');
      expect(result).toBe('clean');
      expect(ctx.fatalError).toBeUndefined();
    });
  });
});
