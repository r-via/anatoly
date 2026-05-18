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

  /**
   * @param capacity Maximum number of concurrent slots (1–32). The upper bound
   *   of 32 prevents accidental API flooding; the lower bound ensures at least
   *   one slot is always available.
   * @throws {RangeError} If capacity is outside the 1–32 range.
   */
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

  /**
   * Acquires a concurrency slot. Resolves immediately if a slot is available;
   * otherwise the returned promise blocks until a slot is freed via {@link release},
   * with waiters served in FIFO order.
   * @returns A promise that resolves once the caller holds a slot.
   */
  acquire(): Promise<void> {
    if (this._running < this._capacity) {
      this._running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  /**
   * Releases a concurrency slot. If waiters are queued, the slot is handed
   * directly to the next waiter (FIFO) without decrementing the running count.
   * If no waiters exist, the running count is decremented to free the slot.
   */
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
