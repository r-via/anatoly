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

  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);

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
 * Apply an axes filter to a list of evaluator IDs, warning if any requested
 * axis is disabled in the config (intersection semantics).
 */
export function warnDisabledAxes(
  axesFilter: AxisId[],
  enabledIds: readonly AxisId[],
): void {
  const log = getLogger();
  for (const id of axesFilter) {
    if (!enabledIds.includes(id)) {
      log.warn({ axis: id }, `axis "${id}" requested via --axes but disabled in config — skipped`);
    }
  }
}
