// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { executeComposer } from './executor.js';
import type { CentralExchange, ResourceGateway } from './types.js';
import type { ComposerEntry } from './registry/composers/types.js';
import * as loggerModule from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockExchange(): CentralExchange {
  const store = new Map<string, unknown>();
  return {
    write<T>(_stepId: string, output: T, _schema: z.ZodTypeAny): void {
      store.set(_stepId, output);
    },
    read<T>(stepId: string, _schema: z.ZodType<T>): T {
      if (!store.has(stepId)) throw new Error(`step "${stepId}" not produced yet`);
      return store.get(stepId) as T;
    },
    has(stepId: string): boolean {
      return store.has(stepId);
    },
    snapshot(): Record<string, unknown> {
      return Object.fromEntries(store);
    },
  };
}

function createTrackingGateway(
  responses: Record<string, unknown>,
): ResourceGateway & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    async invoke(primitiveId: string, _input: unknown) {
      order.push(primitiveId);
      const output = responses[primitiveId] ?? { id: primitiveId };
      return { output, outputSchema: z.any() };
    },
  };
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeComposer', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    vi.spyOn(loggerModule, 'getLogger').mockReturnValue(
      mockLogger as unknown as loggerModule.Logger,
    );
  });

  // -----------------------------------------------------------------------
  // Linear DAG (A → B → C) executes in order
  // -----------------------------------------------------------------------

  describe('linear DAG (A → B → C)', () => {
    it('should execute steps in topological order', async () => {
      const gateway = createTrackingGateway({
        'prim.a': 'resultA',
        'prim.b': 'resultB',
        'prim.c': 'resultC',
      });

      const composer: ComposerEntry = {
        name: 'test-linear',
        plan: {
          steps: [
            { id: 'a', primitive: 'prim.a' },
            { id: 'b', primitive: 'prim.b', readsFrom: ['a'] },
            { id: 'c', primitive: 'prim.c', readsFrom: ['a', 'b'] },
          ],
        },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      await executeComposer(composer, {}, exchange, gateway);

      // Strict sequential order due to dependencies
      expect(gateway.order).toEqual(['prim.a', 'prim.b', 'prim.c']);
    });

    it('should write each step output to exchange', async () => {
      const gateway = createTrackingGateway({
        'prim.a': 'resultA',
        'prim.b': 'resultB',
      });

      const composer: ComposerEntry = {
        name: 'test-write',
        plan: {
          steps: [
            { id: 'a', primitive: 'prim.a' },
            { id: 'b', primitive: 'prim.b', readsFrom: ['a'] },
          ],
        },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      await executeComposer(composer, {}, exchange, gateway);

      expect(exchange.read('a', z.any())).toBe('resultA');
      expect(exchange.read('b', z.any())).toBe('resultB');
    });
  });

  // -----------------------------------------------------------------------
  // Parallel branches execute concurrently
  // -----------------------------------------------------------------------

  describe('parallel branches', () => {
    it('should execute independent steps concurrently', async () => {
      const startTimes: Record<string, number> = {};
      const gateway: ResourceGateway = {
        async invoke(primitiveId: string, _input: unknown) {
          startTimes[primitiveId] = Date.now();
          await new Promise((r) => setTimeout(r, 20));
          return { output: `result-${primitiveId}`, outputSchema: z.any() };
        },
      };

      const steps = Array.from({ length: 7 }, (_, i) => ({
        id: `s${i}`,
        primitive: `p${i}`,
      }));

      const composer: ComposerEntry = {
        name: 'test-parallel',
        plan: { steps },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      const start = Date.now();
      await executeComposer(composer, {}, exchange, gateway);
      const elapsed = Date.now() - start;

      // All 7 should run concurrently — total time ~20ms, not ~140ms
      // Use generous threshold for CI variability
      expect(elapsed).toBeLessThan(100);
      // All results written
      for (let i = 0; i < 7; i++) {
        expect(exchange.has(`s${i}`)).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Conditional skip propagates downstream
  // -----------------------------------------------------------------------

  describe('conditional skip', () => {
    it('should skip step when condition returns false', async () => {
      const gateway = createTrackingGateway({ 'prim.a': 'resultA' });

      const composer: ComposerEntry = {
        name: 'test-skip',
        plan: {
          steps: [
            { id: 'a', primitive: 'prim.a' },
            {
              id: 'b',
              primitive: 'prim.b',
              readsFrom: ['a'],
              condition: () => false,
            },
          ],
        },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      await executeComposer(composer, {}, exchange, gateway);

      // Only prim.a was invoked, prim.b was skipped
      expect(gateway.order).toEqual(['prim.a']);
      expect(exchange.has('b')).toBe(false);
    });

    it('should propagate skip to downstream dependents', async () => {
      const gateway = createTrackingGateway({
        'prim.a': 'resultA',
      });

      const composer: ComposerEntry = {
        name: 'test-skip-cascade',
        plan: {
          steps: [
            { id: 'a', primitive: 'prim.a' },
            {
              id: 'b',
              primitive: 'prim.b',
              readsFrom: ['a'],
              condition: () => false,
            },
            {
              id: 'c',
              primitive: 'prim.c',
              readsFrom: ['b'], // depends on skipped step
            },
          ],
        },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      await executeComposer(composer, {}, exchange, gateway);

      // Only prim.a ran; b was condition-skipped, c was upstream-skipped
      expect(gateway.order).toEqual(['prim.a']);
      expect(exchange.has('b')).toBe(false);
      expect(exchange.has('c')).toBe(false);
    });

    it('should emit step_skipped events', async () => {
      const gateway = createTrackingGateway({ 'prim.a': 'resultA' });

      const composer: ComposerEntry = {
        name: 'test-skip-events',
        plan: {
          steps: [
            { id: 'a', primitive: 'prim.a' },
            {
              id: 'b',
              primitive: 'prim.b',
              readsFrom: ['a'],
              condition: () => false,
            },
            {
              id: 'c',
              primitive: 'prim.c',
              readsFrom: ['b'],
            },
          ],
        },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      await executeComposer(composer, {}, exchange, gateway);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'step_skipped',
          stepId: 'b',
          reason: 'condition_false',
        }),
        expect.any(String),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'step_skipped',
          stepId: 'c',
          reason: 'upstream_skipped',
        }),
        expect.any(String),
      );
    });
  });

  // -----------------------------------------------------------------------
  // onFailure: 'abort' stops execution and rethrows
  // -----------------------------------------------------------------------

  describe('onFailure: abort', () => {
    it('should stop execution and rethrow', async () => {
      const gateway: ResourceGateway = {
        async invoke(primitiveId: string) {
          if (primitiveId === 'prim.b') throw new Error('b exploded');
          return { output: `result-${primitiveId}`, outputSchema: z.any() };
        },
      };

      const composer: ComposerEntry = {
        name: 'test-abort',
        plan: {
          steps: [
            { id: 'a', primitive: 'prim.a' },
            {
              id: 'b',
              primitive: 'prim.b',
              readsFrom: ['a'],
              onFailure: 'abort',
            },
            { id: 'c', primitive: 'prim.c', readsFrom: ['b'] },
          ],
        },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      await expect(
        executeComposer(composer, {}, exchange, gateway),
      ).rejects.toThrow('b exploded');

      // c should not have run
      expect(exchange.has('c')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // onFailure: 'continue' logs and continues
  // -----------------------------------------------------------------------

  describe('onFailure: continue', () => {
    it('should log warning and continue execution', async () => {
      const gateway: ResourceGateway = {
        async invoke(primitiveId: string) {
          if (primitiveId === 'prim.b') throw new Error('b failed');
          return { output: `result-${primitiveId}`, outputSchema: z.any() };
        },
      };

      const composer: ComposerEntry = {
        name: 'test-continue',
        plan: {
          steps: [
            { id: 'a', primitive: 'prim.a' },
            {
              id: 'b',
              primitive: 'prim.b',
              readsFrom: ['a'],
              onFailure: 'continue',
            },
            {
              id: 'c',
              primitive: 'prim.c',
              // c does NOT depend on b, so it can still run
            },
          ],
        },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      await executeComposer(composer, {}, exchange, gateway);

      // a and c ran, b failed but continued
      expect(exchange.has('a')).toBe(true);
      expect(exchange.has('b')).toBe(false);
      expect(exchange.has('c')).toBe(true);

      // Warning logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stepId: 'b' }),
        expect.any(String),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Return value matches composer.outputSchema
  // -----------------------------------------------------------------------

  describe('return value', () => {
    it('should return last step output from exchange', async () => {
      const gateway = createTrackingGateway({
        'prim.a': { value: 1 },
        'prim.b': { value: 2 },
      });

      const composer: ComposerEntry = {
        name: 'test-output',
        plan: {
          steps: [
            { id: 'a', primitive: 'prim.a' },
            { id: 'b', primitive: 'prim.b', readsFrom: ['a'] },
          ],
        },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      const result = await executeComposer(composer, {}, exchange, gateway);

      // Last step's output
      expect(result).toEqual({ value: 2 });
    });
  });

  // -----------------------------------------------------------------------
  // Transform steps (no primitive)
  // -----------------------------------------------------------------------

  describe('transform steps', () => {
    it('should execute inputMapper and write result for steps without primitive', async () => {
      const gateway = createTrackingGateway({ 'prim.a': 10, 'prim.b': 20 });

      const composer: ComposerEntry = {
        name: 'test-transform',
        plan: {
          steps: [
            { id: 'a', primitive: 'prim.a' },
            { id: 'b', primitive: 'prim.b' },
            {
              id: 'merge',
              readsFrom: ['a', 'b'],
              inputMapper: (exchange) => {
                const a = exchange.read('a', z.any()) as number;
                const b = exchange.read('b', z.any()) as number;
                return a + b;
              },
            },
          ],
        },
        inputSchema: z.any(),
        outputSchema: z.any(),
      };

      const exchange = createMockExchange();
      const result = await executeComposer(composer, {}, exchange, gateway);

      expect(result).toBe(30);
    });
  });
});
