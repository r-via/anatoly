/**
 * A concurrency-limited worker pool that processes items through an async handler.
 * Workers run in parallel up to the concurrency limit; when one finishes,
 * the next item starts immediately.
 */
export interface WorkerPoolOptions<T> {
  /** Items to process. */
  items: T[];
  /** Maximum number of concurrent workers. */
  concurrency: number;
  /** Async handler called for each item. */
  handler: (item: T, workerIndex: number) => Promise<void>;
  /** Called when checking whether to stop early (e.g. SIGINT). */
  isInterrupted?: () => boolean;
}

export interface WorkerPoolResult {
  /** Number of items that completed (handler returned). */
  completed: number;
  /** Number of items that threw an error. */
  errored: number;
  /** Number of items skipped due to interruption. */
  skipped: number;
}

/**
 * Run items through a concurrency-limited pool.
 * Returns when all items have been processed or the pool is interrupted.
 *
 * Errors in handlers are swallowed (the caller's handler should catch and handle them).
 * This pool does NOT abort in-flight workers on interrupt — it stops dispatching new ones
 * and waits for active workers to finish.
 */
export async function runWorkerPool<T>(options: WorkerPoolOptions<T>): Promise<WorkerPoolResult> {
  const { items, concurrency, handler, isInterrupted } = options;

  let nextIndex = 0;
  let completed = 0;
  let errored = 0;

  async function runWorker(workerIndex: number): Promise<void> {
    while (nextIndex < items.length) {
      if (isInterrupted?.()) break;

      const itemIndex = nextIndex++;
      const item = items[itemIndex];

      try {
        await handler(item, workerIndex);
        completed++;
      } catch {
        errored++;
      }
    }
  }

  // Launch `concurrency` workers in parallel
  const workers: Promise<void>[] = [];
  const effectiveConcurrency = Math.min(concurrency, items.length);
  for (let i = 0; i < effectiveConcurrency; i++) {
    workers.push(runWorker(i));
  }

  await Promise.all(workers);

  const skipped = items.length - completed - errored;
  return { completed, errored, skipped };
}
