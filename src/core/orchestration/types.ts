// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { z } from 'zod';

// ---------------------------------------------------------------------------
// CentralExchange — typed blackboard between primitives
// ---------------------------------------------------------------------------

/**
 * Carries only Zod-validated typed responses between primitives within a
 * composer execution. Full implementation in exchange.ts (Story 56.4).
 */
export interface CentralExchange {
  write<T>(stepId: string, output: T, schema: z.ZodTypeAny): void;
  read<T>(stepId: string, schema: z.ZodType<T>): T;
  has(stepId: string): boolean;
  snapshot(): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ResourceGateway — invokes primitives via the transport layer
// ---------------------------------------------------------------------------

/**
 * Abstraction over primitive invocation. The gateway resolves the primitive,
 * selects the transport, and returns the validated output along with its
 * schema for exchange writes. Full implementation in a future story.
 */
export interface ResourceGateway {
  invoke(
    primitiveId: string,
    input: unknown,
  ): Promise<{ output: unknown; outputSchema: z.ZodTypeAny }>;
}
