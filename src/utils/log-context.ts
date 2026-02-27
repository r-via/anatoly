import { AsyncLocalStorage } from 'node:async_hooks';
import { getLogger } from './logger.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogContext {
  runId?: string;
  file?: string;
  axis?: string;
  phase?: string;
  worker?: number;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage instance
// ---------------------------------------------------------------------------

const als = new AsyncLocalStorage<LogContext>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute `fn` within a log context. The context is merged with any parent
 * context (nested calls accumulate fields). When `fn` completes (sync or
 * async), the context is automatically cleaned up.
 *
 * @example
 *   runWithContext({ runId: 'abc' }, () => {
 *     runWithContext({ file: 'src/foo.ts' }, () => {
 *       // getLogContext() → { runId: 'abc', file: 'src/foo.ts' }
 *     });
 *   });
 */
export function runWithContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = als.getStore();
  const merged = parent ? { ...parent, ...ctx } : { ...ctx };
  return als.run(merged, fn);
}

/**
 * Return the current log context, or `undefined` if called outside of any
 * `runWithContext` scope.
 */
export function getLogContext(): LogContext | undefined {
  return als.getStore();
}

/**
 * Return a child logger with the current AsyncLocalStorage context fields
 * automatically merged in. If no context is active, the base logger is
 * returned as-is.
 *
 * This is the recommended way to log inside pipeline code — call
 * `contextLogger()` and then use the returned logger.
 */
export function contextLogger(namespace?: string): Logger {
  const base = getLogger();
  const ctx = als.getStore();
  const bindings: Record<string, unknown> = {};

  if (ctx) {
    if (ctx.runId) bindings.runId = ctx.runId;
    if (ctx.file) bindings.file = ctx.file;
    if (ctx.axis) bindings.axis = ctx.axis;
    if (ctx.phase) bindings.phase = ctx.phase;
    if (ctx.worker !== undefined) bindings.worker = ctx.worker;
  }

  if (namespace) {
    bindings.component = namespace;
  }

  return Object.keys(bindings).length > 0 ? base.child(bindings) : base;
}
