// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { getLogger } from '../../utils/logger.js';
import { runWithContext } from '../../utils/log-context.js';
import type { CentralExchange, ResourceGateway } from './types.js';
import type { ComposerEntry, ExecutionStep } from './registry/composers/types.js';

// ---------------------------------------------------------------------------
// executeComposer — DAG executor
// ---------------------------------------------------------------------------

/**
 * Walk the composer's execution plan topologically, invoking primitives via
 * the gateway and writing results to the exchange. Steps with no mutual
 * dependencies run concurrently via `Promise.allSettled`.
 *
 * - `condition` returning false skips the step and all downstream dependents.
 * - `onFailure: 'abort'` (default) halts execution and rethrows.
 * - `onFailure: 'continue'` logs a warning and treats the step as skipped.
 * - Steps without a `primitive` field use `inputMapper` as a pure transform.
 */
export async function executeComposer<I, O>(
  composer: ComposerEntry,
  input: I,
  exchange: CentralExchange,
  gateway: ResourceGateway,
): Promise<O> {
  const log = getLogger();
  const { steps } = composer.plan;
  const completed = new Set<string>();
  const skipped = new Set<string>();

  while (completed.size + skipped.size < steps.length) {
    // Find steps whose dependencies are all resolved (completed or skipped)
    const ready = steps.filter((step) => {
      if (completed.has(step.id) || skipped.has(step.id)) return false;
      const deps = step.readsFrom ?? [];
      return deps.every((dep) => completed.has(dep) || skipped.has(dep));
    });

    if (ready.length === 0) break; // prevent infinite loop on broken DAGs

    // Partition: skip upstream-dependent or condition-false, run the rest
    const toRun: ExecutionStep[] = [];

    for (const step of ready) {
      const deps = step.readsFrom ?? [];

      // Upstream skip propagation
      if (deps.some((dep) => skipped.has(dep))) {
        log.info(
          { event: 'step_skipped', composer: composer.name, stepId: step.id, reason: 'upstream_skipped' },
          'step skipped (upstream dependency was skipped)',
        );
        skipped.add(step.id);
        continue;
      }

      // Condition check
      if (step.condition && !step.condition(exchange)) {
        log.info(
          { event: 'step_skipped', composer: composer.name, stepId: step.id, reason: 'condition_false' },
          'step skipped (condition returned false)',
        );
        skipped.add(step.id);
        continue;
      }

      toRun.push(step);
    }

    if (toRun.length === 0) continue; // all ready steps were skipped, loop again

    // Run ready steps concurrently, each in its own ALS sub-scope
    const results = await Promise.allSettled(
      toRun.map((step) =>
        runWithContext(
          {
            composer: composer.name,
            ...(step.primitive ? { primitive: step.primitive } : {}),
          },
          () => runStep(step, input, exchange, gateway),
        ),
      ),
    );

    // Process results
    for (let i = 0; i < toRun.length; i++) {
      const step = toRun[i];
      const result = results[i];

      if (result.status === 'fulfilled') {
        completed.add(step.id);
      } else {
        const onFailure = step.onFailure ?? 'abort';
        if (onFailure === 'continue') {
          log.warn(
            { composer: composer.name, stepId: step.id, err: result.reason },
            'step failed, continuing',
          );
          skipped.add(step.id);
        } else {
          throw result.reason;
        }
      }
    }
  }

  // Return the last step's output (or exchange snapshot as fallback)
  const lastStep = steps[steps.length - 1];
  if (exchange.has(lastStep.id)) {
    return exchange.read(lastStep.id, composer.outputSchema) as O;
  }

  return exchange.snapshot() as O;
}

// ---------------------------------------------------------------------------
// Internal: run a single step
// ---------------------------------------------------------------------------

async function runStep<I>(
  step: ExecutionStep,
  composerInput: I,
  exchange: CentralExchange,
  gateway: ResourceGateway,
): Promise<void> {
  const mappedInput = step.inputMapper
    ? step.inputMapper(exchange, composerInput)
    : composerInput;

  if (step.primitive) {
    // Invoke primitive via gateway
    const { output, outputSchema } = await gateway.invoke(step.primitive, mappedInput);
    exchange.write(step.id, output, outputSchema);
  } else {
    // Pure transform step — inputMapper's return is the output
    exchange.write(step.id, mappedInput, z.any());
  }
}
