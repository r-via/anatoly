// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { AxisId } from '../core/axis-evaluator.js';
import { ALL_AXIS_IDS } from '../core/axes/index.js';
import { getLogger } from './logger.js';

/**
 * Parse and validate a comma-separated list of axis IDs from the CLI `--axes` option.
 * Returns `undefined` when no filter is provided (all enabled axes run).
 * Throws with a helpful message if any axis ID is invalid.
 */
export function parseAxesFilter(raw: string | undefined): AxisId[] | undefined {
  if (raw === undefined || raw === '') return undefined;

  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];

  const invalid = ids.filter((id) => !ALL_AXIS_IDS.includes(id as AxisId));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown ${invalid.length > 1 ? 'axes' : 'axis'}: ${invalid.join(', ')}. ` +
      `Valid axes: ${ALL_AXIS_IDS.join(', ')}`,
    );
  }

  return ids as AxisId[];
}

/**
 * Parse `--axes` option and set process.exitCode on error.
 * Delegates to {@link parseAxesFilter} for parsing and validation.
 *
 * @param raw - Comma-separated axis IDs from the `--axes` CLI option.
 * @returns The parsed axis filter, `undefined` when `raw` is absent/empty,
 *          or `null` if parsing failed (sets `process.exitCode` to `2`; caller should return early).
 */
export function parseAxesOption(raw: string | undefined): AxisId[] | undefined | null {
  try {
    return parseAxesFilter(raw);
  } catch (err) {
    console.error(`anatoly — error: ${(err as Error).message}`);
    process.exitCode = 2;
    return null;
  }
}

/**
 * Warn when axes requested via `--axes` are not in the post-filter evaluator list
 * (i.e. disabled in config). Should be called once at startup, not per-file.
 *
 * @param axesFilter - Axis IDs explicitly requested by the user via `--axes`.
 * @param filteredIds - Axis IDs that are actually enabled after applying config filters.
 */
export function warnDisabledAxes(
  axesFilter: AxisId[],
  filteredIds: readonly AxisId[],
): void {
  const log = getLogger();
  for (const id of axesFilter) {
    if (!filteredIds.includes(id)) {
      log.warn({ axis: id }, `axis "${id}" requested via --axes but disabled in config — skipped`);
    }
  }
}
