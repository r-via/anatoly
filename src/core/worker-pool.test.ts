import { describe, it, expect, vi } from 'vitest';
import { runWorkerPool } from './worker-pool.js';

describe('runWorkerPool', () => {
  it('should process all items sequentially with concurrency 1', async () => {
    const processed: number[] = [];

    const result = await runWorkerPool({
      items: [1, 2, 3],
      concurrency: 1,
      handler: async (item) => {
        processed.push(item);
      },
    });

    expect(processed).toEqual([1, 2, 3]);
    expect(result.completed).toBe(3);
    expect(result.errored).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('should process items concurrently with concurrency > 1', async () => {
    const startTimes: number[] = [];
    const endTimes: number[] = [];

    const result = await runWorkerPool({
      items: [0, 1, 2],
      concurrency: 3,
      handler: async (item) => {
        startTimes[item] = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        endTimes[item] = Date.now();
      },
    });

    expect(result.completed).toBe(3);

    // All 3 should have started before any finished (concurrency 3)
    // Allow some timing slack — check that all started within 30ms of each other
    const maxStart = Math.max(...startTimes);
    const minStart = Math.min(...startTimes);
    expect(maxStart - minStart).toBeLessThan(40);
  });

  it('should limit concurrency to the specified value', async () => {
    let activeConcurrent = 0;
    let maxConcurrent = 0;

    const result = await runWorkerPool({
      items: [0, 1, 2, 3, 4, 5],
      concurrency: 2,
      handler: async () => {
        activeConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, activeConcurrent);
        await new Promise((r) => setTimeout(r, 30));
        activeConcurrent--;
      },
    });

    expect(result.completed).toBe(6);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBe(2); // with 6 items and concurrency 2, we should hit 2
  });

  it('should stop dispatching new items when interrupted', async () => {
    let shouldInterrupt = false;
    const processed: number[] = [];

    const result = await runWorkerPool({
      items: [0, 1, 2, 3, 4],
      concurrency: 1,
      isInterrupted: () => shouldInterrupt,
      handler: async (item) => {
        processed.push(item);
        if (item === 1) shouldInterrupt = true;
      },
    });

    // Should have processed items 0 and 1, then stopped
    expect(processed).toEqual([0, 1]);
    expect(result.completed).toBe(2);
    expect(result.skipped).toBe(3);
  });

  it('should count errored items', async () => {
    const result = await runWorkerPool({
      items: [0, 1, 2],
      concurrency: 1,
      handler: async (item) => {
        if (item === 1) throw new Error('fail');
      },
    });

    expect(result.completed).toBe(2);
    expect(result.errored).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('should handle empty items list', async () => {
    const result = await runWorkerPool({
      items: [],
      concurrency: 3,
      handler: async () => { /* noop */ },
    });

    expect(result.completed).toBe(0);
    expect(result.errored).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('should not spawn more workers than items', async () => {
    let maxConcurrent = 0;
    let activeConcurrent = 0;

    await runWorkerPool({
      items: [0, 1],
      concurrency: 10,
      handler: async () => {
        activeConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, activeConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        activeConcurrent--;
      },
    });

    expect(maxConcurrent).toBe(2); // only 2 items, so max 2 workers
  });

  it('should start next item immediately when a slot frees up', async () => {
    const order: string[] = [];

    await runWorkerPool({
      items: ['fast', 'slow', 'afterSlow'],
      concurrency: 2,
      handler: async (item) => {
        order.push(`start:${item}`);
        await new Promise((r) => setTimeout(r, item === 'slow' ? 60 : 10));
        order.push(`end:${item}`);
      },
    });

    // 'fast' should complete before 'slow', and 'afterSlow' should start after 'fast' ends
    expect(order.indexOf('end:fast')).toBeLessThan(order.indexOf('end:slow'));
    expect(order.indexOf('start:afterSlow')).toBeLessThan(order.indexOf('end:slow'));
  });
});
