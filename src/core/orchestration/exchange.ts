// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { ZodError, type z } from 'zod';
import type { CentralExchange } from './types.js';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class ExchangeWriteError extends Error {
  override name = 'ExchangeWriteError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class ExchangeReadError extends Error {
  override name = 'ExchangeReadError' as const;
  constructor(message: string) {
    super(message);
  }
}

export class ExchangeSchemaMismatchError extends Error {
  override name = 'ExchangeSchemaMismatchError' as const;
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// createExchange
// ---------------------------------------------------------------------------

/**
 * Create an isolated CentralExchange instance that enforces Zod validation
 * on every write and read. Data is deep-copied on write to prevent external
 * mutations from affecting stored state.
 */
export function createExchange(): CentralExchange {
  const store = new Map<string, unknown>();

  return {
    write<T>(stepId: string, output: T, schema: z.ZodTypeAny): void {
      try {
        schema.parse(output);
      } catch (err) {
        if (err instanceof ZodError) {
          const details = err.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          throw new ExchangeWriteError(
            `step "${stepId}" output failed validation: ${details}`,
          );
        }
        throw err;
      }
      // Deep-copy on write to prevent external mutations
      store.set(stepId, structuredClone(output));
    },

    read<T>(stepId: string, schema: z.ZodType<T>): T {
      if (!store.has(stepId)) {
        throw new ExchangeReadError(
          `step "${stepId}" has not produced output yet`,
        );
      }

      const raw = store.get(stepId);
      try {
        return schema.parse(raw);
      } catch (err) {
        if (err instanceof ZodError) {
          const details = err.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          throw new ExchangeSchemaMismatchError(
            `step "${stepId}" output does not match read schema: ${details}`,
          );
        }
        throw err;
      }
    },

    has(stepId: string): boolean {
      return store.has(stepId);
    },

    snapshot(): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      for (const [key, value] of store) {
        result[key] = structuredClone(value);
      }
      return result;
    },
  };
}
