// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { z } from 'zod';
import type { CentralExchange } from '../../types.js';

// ---------------------------------------------------------------------------
// ExecutionStep
// ---------------------------------------------------------------------------

export interface ExecutionStep {
  /** Unique identifier within this plan. */
  id: string;
  /** Reference to a primitive in the PRIMITIVES registry. */
  primitive?: string;
  /** Reference to a sub-composer in the COMPOSERS registry. */
  composer?: string;
  /** Step IDs this step depends on (must complete before this step runs). */
  readsFrom?: string[];
  /** Skip this step if condition returns false. Downstream dependents are also skipped. */
  condition?: (exchange: CentralExchange) => boolean;
  /** What to do when this step fails: 'abort' (default) or 'continue'. */
  onFailure?: 'abort' | 'continue';
  /** Transform input from exchange / composer input before passing to primitive. */
  inputMapper?: (exchange: CentralExchange, composerInput: unknown) => unknown;
}

// ---------------------------------------------------------------------------
// ExecutionPlan
// ---------------------------------------------------------------------------

export interface ExecutionPlan {
  steps: ExecutionStep[];
}

// ---------------------------------------------------------------------------
// ComposerEntry
// ---------------------------------------------------------------------------

export interface ComposerEntry {
  /** Unique name matching the map key. */
  name: string;
  /** Declarative DAG plan. */
  plan: ExecutionPlan;
  /** Schema for the composer's input. */
  inputSchema: z.ZodTypeAny;
  /** Schema for the composer's output (validated from the last step). */
  outputSchema: z.ZodTypeAny;
}
