// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `platform/` bounded context: shared primitives the phases consume.
 *
 * Concurrency / resilience (`Semaphore`, `runWorkerPool`, `CircuitBreaker`)
 * and LLM-call support (`resolveSystemPrompt`, `DEFAULT_MODELS`,
 * deliberation-memory). A pure leaf: no out-edges to other core contexts.
 *
 * Published surface (doc 12 §1 rule 1, doc 13 PR 3). Everything outside this
 * context imports this barrel, never a module path inside it. The surface is
 * exactly the symbols current external importers use, no speculative API
 * (doc 13 §8): `grammar-manager` has no external importer and is therefore
 * intentionally absent from the barrel.
 */

export { Semaphore } from './sdk-semaphore.js';

export { runWorkerPool } from './worker-pool.js';
export type { WorkerPoolOptions } from './worker-pool.js';

export { CircuitBreaker } from './circuit-breaker.js';
export type { CircuitState } from './circuit-breaker.js';

export { resolveSystemPrompt, _resetPromptRegistry, _getRegistryKeys } from './prompt-resolver.js';

export { DEFAULT_MODELS } from './default-models.js';

export {
  saveDeliberationMemory,
  recordReclassification,
  formatReclassificationsForAxis,
} from './correction-memory.js';
export type { AxisReclassification, ReclassificationEntry } from './correction-memory.js';
