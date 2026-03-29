// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { ConfigSchema } from '../schemas/config.js';
import type { Config } from '../schemas/config.js';
import { AnatolyError, ERROR_CODES } from './errors.js';

const CONFIG_FILENAME = '.anatoly.yml';

/** Mechanical axes that were routed to Gemini Flash in the legacy config. */
const MECHANICAL_AXES = ['utility', 'duplication', 'overengineering'] as const;

/**
 * Detect whether a raw parsed YAML object uses the legacy v0 config format
 * (has `llm` key, no `models` key).
 */
function isLegacyConfig(obj: Record<string, unknown>): boolean {
  return 'llm' in obj && !('models' in obj);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Migrate a legacy v0 config object (with `llm.*`) to v1.0 format
 * (providers/models/agents/runtime/axes).
 *
 * If the object is already in v1.0 format (has `models` key), it is returned unchanged.
 * The `llm` key is removed from the result after migration.
 */
export function migrateConfigV0toV1(raw: Record<string, any>): Record<string, any> {
  // Already v1.0 — no migration needed
  if (!isLegacyConfig(raw)) {
    return raw;
  }

  const llm = raw.llm as Record<string, any>;
  const result: Record<string, any> = {};

  // Copy non-llm keys
  for (const key of Object.keys(raw)) {
    if (key !== 'llm') {
      result[key] = raw[key];
    }
  }

  // --- models ---
  const models: Record<string, any> = {};
  if (llm.model !== undefined) models.quality = llm.model;
  // fast_model ?? index_model
  if (llm.fast_model !== undefined) {
    models.fast = llm.fast_model;
  } else if (llm.index_model !== undefined) {
    models.fast = llm.index_model;
  }
  if (llm.deliberation_model !== undefined) models.deliberation = llm.deliberation_model;

  // --- providers ---
  const providers: Record<string, any> = {};
  if (llm.sdk_concurrency !== undefined) {
    providers.anthropic = { concurrency: llm.sdk_concurrency };
  }

  // --- runtime ---
  const runtime: Record<string, any> = {};
  if (llm.timeout_per_file !== undefined) runtime.timeout_per_file = llm.timeout_per_file;
  if (llm.max_retries !== undefined) runtime.max_retries = llm.max_retries;
  if (llm.concurrency !== undefined) runtime.concurrency = llm.concurrency;
  if (llm.min_confidence !== undefined) runtime.min_confidence = llm.min_confidence;
  if (llm.max_stop_iterations !== undefined) runtime.max_stop_iterations = llm.max_stop_iterations;

  // --- agents ---
  // llm.deliberation controlled deliberation only — map to agents.enabled
  // (currently agents.enabled only gates deliberation in run.ts/review.ts)
  const agents: Record<string, any> = {};
  if (llm.deliberation !== undefined) agents.enabled = llm.deliberation;

  // --- axes ---
  let axes: Record<string, any> | undefined;
  if (llm.axes !== undefined) {
    axes = { ...llm.axes };
  }

  // --- gemini → providers.google + mechanical axes + code_summary ---
  const gemini = llm.gemini as Record<string, any> | undefined;
  if (gemini?.enabled === true) {
    const mode = gemini.type === 'genai' ? 'api' : 'subscription';
    const google: Record<string, any> = { mode };
    if (gemini.sdk_concurrency !== undefined) google.concurrency = gemini.sdk_concurrency;
    providers.google = google;

    // Propagate flash_model to mechanical axes without existing override
    if (gemini.flash_model) {
      if (!axes) axes = {};
      for (const axisId of MECHANICAL_AXES) {
        const existing = axes[axisId] as Record<string, any> | undefined;
        if (!existing?.model) {
          axes[axisId] = { ...existing, model: gemini.flash_model };
        }
      }
    }

    // nlp_model → models.code_summary
    if (gemini.nlp_model) {
      models.code_summary = gemini.nlp_model;
    }
  }

  // Assemble result
  if (Object.keys(models).length > 0) result.models = models;
  if (Object.keys(providers).length > 0) result.providers = providers;
  if (Object.keys(runtime).length > 0) result.runtime = runtime;
  if (Object.keys(agents).length > 0) result.agents = agents;
  if (axes) result.axes = axes;

  return result;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Load Anatoly configuration from `.anatoly.yml` in the given directory.
 * Falls back to sensible defaults if no config file exists.
 * Throws AnatolyError CONFIG_INVALID for malformed YAML or invalid config.
 *
 * Legacy v0 configs (with `llm` section) are automatically migrated to v1.0
 * format and a deprecation warning is emitted to stderr.
 */
export function loadConfig(projectRoot: string, configPath?: string): Config {
  const filePath = configPath ?? resolve(projectRoot, CONFIG_FILENAME);

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    // No config file → return defaults
    return ConfigSchema.parse({});
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new AnatolyError(
      `Invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      ERROR_CODES.CONFIG_INVALID,
      false,
      `check YAML syntax in ${filePath} — indentation must use spaces, not tabs`,
    );
  }

  // yaml.load returns undefined for empty files, null for "null" content
  if (parsed == null) {
    return ConfigSchema.parse({});
  }

  // Guard against non-object YAML (arrays, scalars)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AnatolyError(
      `.anatoly.yml must contain a YAML mapping (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
      'CONFIG_INVALID',
      false,
    );
  }

  // Migrate legacy v0 config if detected
  let configObj = parsed as Record<string, unknown>;
  if (isLegacyConfig(configObj)) {
    process.stderr.write(
      '\n⚠ .anatoly.yml uses the legacy `llm` section (pre-v1.0).\n' +
      '  Run `anatoly migrate-config` to update your config file.\n' +
      '  Legacy format supported until v2.0.\n\n',
    );
    configObj = migrateConfigV0toV1(configObj);
  }

  const result = ConfigSchema.safeParse(configObj);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    const firstKey = result.error.issues[0]?.path.join('.') ?? 'unknown';
    throw new AnatolyError(
      `Invalid configuration in ${filePath}:\n${issues}`,
      ERROR_CODES.CONFIG_INVALID,
      false,
      `fix the \`${firstKey}\` key in ${filePath} — see documentation for valid values`,
    );
  }

  return result.data;
}
