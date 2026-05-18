// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { Semaphore } from './sdk-semaphore.js';

describe('Semaphore', () => {
  it('initializes with correct capacity', () => {
    const sem = new Semaphore(8);

    expect(sem.running).toBe(0);
    expect(sem.available).toBe(8);
    expect(sem.waiting).toBe(0);
  });

  it('acquire resolves immediately when slots available', async () => {
    const sem = new Semaphore(3);
    await sem.acquire();

    expect(sem.running).toBe(1);
    expect(sem.available).toBe(2);
  });

  it('release frees a slot', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();

    expect(sem.available).toBe(0);
    sem.release();

    expect(sem.running).toBe(1);
    expect(sem.available).toBe(1);
  });

  it('queues when all slots taken', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();

    let resolved = false;
    const pending = sem.acquire().then(() => {
      resolved = true;
    });

    // Not resolved yet — both slots taken
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(sem.waiting).toBe(1);

    // Release one slot → queued acquire resolves
    sem.release();
    await pending;

    expect(resolved).toBe(true);
    expect(sem.running).toBe(2);
    expect(sem.waiting).toBe(0);
  });

  it('processes waiting acquires in FIFO order', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];

    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    expect(sem.waiting).toBe(3);

    sem.release(); // resolves p1
    await p1;
    sem.release(); // resolves p2
    await p2;
    sem.release(); // resolves p3
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it('never exceeds capacity under concurrent pressure', async () => {
    const sem = new Semaphore(3);
    let maxRunning = 0;

    const task = async () => {
      await sem.acquire();
      try {
        maxRunning = Math.max(maxRunning, sem.running);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 5));
      } finally {
        sem.release();
      }
    };

    // Launch 10 concurrent tasks against 3 slots
    await Promise.all(Array.from({ length: 10 }, () => task()));

    expect(maxRunning).toBe(3);
    expect(sem.running).toBe(0);
    expect(sem.available).toBe(3);
  });

  it('releases slot via finally even on error', async () => {
    const sem = new Semaphore(2);

    try {
      await sem.acquire();
      throw new Error('simulated crash');
    } catch {
      // expected
    } finally {
      sem.release();
    }

    expect(sem.running).toBe(0);
    expect(sem.available).toBe(2);
  });

  it('release without acquire does not exceed capacity', () => {
    const sem = new Semaphore(2);
    sem.release(); // spurious release

    expect(sem.running).toBe(0);
    expect(sem.available).toBe(2);
  });

  it('validates capacity (min 1, max 32)', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(33)).toThrow();
    expect(() => new Semaphore(1)).not.toThrow();
    expect(() => new Semaphore(32)).not.toThrow();
  });
});
