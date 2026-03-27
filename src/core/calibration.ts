// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Per-axis calibration data, derived from real run timings.
 * Stored in .anatoly/calibration.json and updated after each run.
 */

export interface AxisCalibration {
  /** Median duration in ms per file for this axis */
  medianMs: number;
  /** Number of samples used to compute the median */
  samples: number;
}

export interface CalibrationData {
  /** Schema version for forward compat */
  version: 1;
  /** ISO timestamp of last calibration update */
  updatedAt: string;
  /** Per-axis calibration keyed by axisId */
  axes: Record<string, AxisCalibration>;
}

/**
 * Default medians (ms) per axis, derived from empirical measurements.
 * Used when no calibration data exists yet.
 */
const DEFAULT_MEDIANS: Record<string, number> = {
  duplication: 10_400,
  utility: 13_500,
  overengineering: 19_000,
  tests: 21_700,
  documentation: 60_000,
  correction: 83_000,
  best_practices: 117_100,
};

function calibrationPath(projectRoot: string): string {
  return resolve(projectRoot, '.anatoly', 'calibration.json');
}

/**
 * Load calibration data from disk, falling back to defaults.
 */
export function loadCalibration(projectRoot: string): CalibrationData {
  const path = calibrationPath(projectRoot);
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as CalibrationData;
      if (data.version === 1 && typeof data.axes === 'object' && data.axes !== null) return data;
    } catch {
      // Corrupt file — fall through to defaults
    }
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    axes: Object.fromEntries(
      Object.entries(DEFAULT_MEDIANS).map(([id, ms]) => [id, { medianMs: ms, samples: 0 }]),
    ),
  };
}

/**
 * Save calibration data to disk.
 */
export function saveCalibration(projectRoot: string, data: CalibrationData): void {
  const path = calibrationPath(projectRoot);
  mkdirSync(resolve(projectRoot, '.anatoly'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Compute median of a numeric array.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

interface RunMetrics {
  axisStats: Record<string, { calls: number; totalDurationMs: number }>;
}

/**
 * Recalculate calibration from all historical run-metrics.json files.
 * Collects per-file durations (totalDurationMs / calls) per axis across all runs,
 * then computes the median. Falls back to defaults for axes with no data.
 */
export function recalibrateFromRuns(projectRoot: string): CalibrationData {
  const runsDir = resolve(projectRoot, '.anatoly', 'runs');
  if (!existsSync(runsDir)) return loadCalibration(projectRoot);

  // Only use the most recent runs to bound I/O and keep calibration fresh
  const MAX_CALIBRATION_RUNS = 20;
  const allRunDirs = readdirSync(runsDir).filter(d => d !== 'latest').sort();
  const runDirs = allRunDirs.slice(-MAX_CALIBRATION_RUNS);

  // Collect per-axis average-per-file durations from each run
  const perAxisSamples: Record<string, number[]> = {};
  let skipped = 0;

  for (const dir of runDirs) {
    const metricsPath = join(runsDir, dir, 'run-metrics.json');
    if (!existsSync(metricsPath)) continue;
    try {
      const metrics = JSON.parse(readFileSync(metricsPath, 'utf-8')) as RunMetrics;
      if (!metrics.axisStats) continue;
      for (const [axisId, stats] of Object.entries(metrics.axisStats)) {
        if (stats.calls > 0) {
          const avgPerFile = stats.totalDurationMs / stats.calls;
          (perAxisSamples[axisId] ??= []).push(avgPerFile);
        }
      }
    } catch {
      skipped++;
    }
  }

  if (skipped > 0) {
    // eslint-disable-next-line no-console
    console.warn(`calibration: skipped ${skipped} unreadable run-metrics.json file(s)`);
  }

  const axes: Record<string, AxisCalibration> = {};

  // For each known axis, use real data if available, otherwise default
  for (const [axisId, defaultMs] of Object.entries(DEFAULT_MEDIANS)) {
    const samples = perAxisSamples[axisId];
    if (samples && samples.length > 0) {
      axes[axisId] = { medianMs: Math.round(median(samples)), samples: samples.length };
    } else {
      axes[axisId] = { medianMs: defaultMs, samples: 0 };
    }
  }

  // Include any axes not in defaults (future-proof)
  for (const [axisId, samples] of Object.entries(perAxisSamples)) {
    if (!axes[axisId] && samples.length > 0) {
      axes[axisId] = { medianMs: Math.round(median(samples)), samples: samples.length };
    }
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    axes,
  };
}

/** Estimated deliberation time per file (Opus pass, ~45s median) */
const DELIBERATION_MS_PER_FILE = 45_000;
/** Fraction of files that typically require deliberation (~60%) */
const DELIBERATION_FILE_RATIO = 0.6;
/** Estimated RAG indexing overhead in ms (lite ~30s, advanced ~5min) */
const RAG_INDEX_MS = 300_000;

/**
 * Estimate total review duration in minutes for a set of files,
 * using calibration data for active axes with concurrency factor.
 *
 * The estimate is composed of three sequential phases:
 * 1. RAG indexing (fixed overhead, skippable via `options.rag`)
 * 2. Axis evaluation (wall time = slowest axis, divided by concurrency)
 * 3. Deliberation (per-file Opus pass for ~60% of files, skippable via `options.deliberation`)
 *
 * @param calibration - Per-axis timing data from previous runs.
 * @param fileCount - Number of files to review.
 * @param activeAxes - Axis IDs that will be evaluated.
 * @param concurrency - Number of concurrent file reviews.
 * @param concurrencyEfficiency - Scaling factor for parallel efficiency (default: 0.75).
 * @param options - Optional flags to include/exclude RAG and deliberation phases
 *                  (both default to `true` when omitted).
 * @returns Estimated wall-clock time in whole minutes (rounded up).
 */
export function estimateCalibratedMinutes(
  calibration: CalibrationData,
  fileCount: number,
  activeAxes: string[],
  concurrency: number,
  concurrencyEfficiency = 0.75,
  options?: { rag?: boolean; deliberation?: boolean },
): number {
  if (fileCount === 0 || activeAxes.length === 0) return 0;

  // Phase 1: RAG indexing — fixed overhead, runs once before reviews
  const ragMs = options?.rag !== false ? RAG_INDEX_MS : 0;

  // Phase 2: Axis evaluation — axes run in parallel per file, wall time = slowest axis
  let slowestAxisMs = 0;
  for (const axisId of activeAxes) {
    const cal = calibration.axes[axisId];
    const axisMs = cal?.medianMs ?? DEFAULT_MEDIANS[axisId] ?? 20_000;
    if (axisMs > slowestAxisMs) slowestAxisMs = axisMs;
  }
  const reviewTotalMs = slowestAxisMs * fileCount;
  const reviewMs = concurrency > 1
    ? reviewTotalMs / (concurrency * concurrencyEfficiency)
    : reviewTotalMs;

  // Phase 3: Deliberation — runs after axes, per file with findings
  let deliberationMs = 0;
  if (options?.deliberation !== false) {
    const filesWithFindings = Math.ceil(fileCount * DELIBERATION_FILE_RATIO);
    const deliberationTotalMs = DELIBERATION_MS_PER_FILE * filesWithFindings;
    deliberationMs = concurrency > 1
      ? deliberationTotalMs / (concurrency * concurrencyEfficiency)
      : deliberationTotalMs;
  }

  return Math.ceil((ragMs + reviewMs + deliberationMs) / 60_000);
}

/**
 * Format calibrated estimate label for display.
 * Shows "~Xh Ym" or "~Xm" depending on duration.
 */
export function formatCalibratedTime(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
  }
  return `~${minutes}m`;
}
