// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Global SDK Concurrency Semaphore — Story 30.1
 *
 * Bounds the total number of concurrent Claude SDK calls so the system
 * doesn't flood the API when file concurrency × axis count grows.
 * Queued acquires resolve in FIFO order.
 */

export class Semaphore {
  private _running = 0;
  private readonly _capacity: number;
  private readonly _queue: Array<() => void> = [];

  constructor(capacity: number) {
    if (capacity < 1 || capacity > 32) {
      throw new RangeError(`Semaphore capacity must be 1-32, got ${capacity}`);
    }
    this._capacity = capacity;
  }

  get running(): number {
    return this._running;
  }

  get capacity(): number {
    return this._capacity;
  }

  get available(): number {
    return this._capacity - this._running;
  }

  get waiting(): number {
    return this._queue.length;
  }

  acquire(): Promise<void> {
    if (this._running < this._capacity) {
      this._running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      // Hand slot directly to next waiter (FIFO)
      const next = this._queue.shift()!;
      next();
    } else if (this._running > 0) {
      this._running--;
    }
  }
}
