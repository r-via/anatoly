// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `harness/` bounded context barrel (doc 12 §1 rule 1: outside a context
 * import this barrel, never a module path inside it). The shared kernel for
 * the execution-unit SPI; depends on nothing in `core/`.
 */

export type { ExecutionUnit, HarnessCtx } from './contract.js';
export { runUnit } from './runner.js';
