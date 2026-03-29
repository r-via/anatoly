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
 * Add a provider prefix to a bare model name based on inference rules.
 * Already-prefixed names (containing `/`) are returned unchanged.
 *
 * - `claude-*` → `anthropic/claude-*`
 * - `gemini-*` → `google/gemini-*`
 * - unknown   → unchanged (left bare)
 */
function prefixModel(name: string): string {
  if (name.includes('/')) return name;
  if (name.startsWith('claude-')) return `anthropic/${name}`;
  if (name.startsWith('gemini-')) return `google/${name}`;
  if (name.startsWith('gpt-')) return `openai/${name}`;
  return name;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Detect whether a raw config object is v1 format: has `models` section with
 * at least one bare (un-prefixed) model name.
 */
export function isV1Config(obj: Record<string, any>): boolean {
  const models = obj.models as Record<string, any> | undefined;
  if (!models || typeof models !== 'object') return false;
  for (const value of Object.values(models)) {
    if (typeof value === 'string' && !value.includes('/')) return true;
  }
  // Also check axes.*.model and agents.* string values
  const axes = obj.axes as Record<string, any> | undefined;
  if (axes && typeof axes === 'object') {
    for (const axis of Object.values(axes)) {
      if (axis && typeof axis === 'object' && typeof (axis as any).model === 'string' && !(axis as any).model.includes('/')) {
        return true;
      }
    }
  }
  const agents = obj.agents as Record<string, any> | undefined;
  if (agents && typeof agents === 'object') {
    for (const [key, value] of Object.entries(agents)) {
      if (key !== 'enabled' && typeof value === 'string' && !value.includes('/')) return true;
    }
  }
  return false;
}

/**
 * Migrate a v1 config (bare model names) to v2 format (prefixed model names).
 *
 * Applies `prefixModel()` to all model name strings in:
 * - `models.*`
 * - `axes.*.model`
 * - `agents.*` (string values only, excluding `enabled`)
 *
 * If no migration is needed (no bare model names found), returns the input unchanged.
 */
export function migrateConfigV1toV2(raw: Record<string, any>): Record<string, any> {
  const result = { ...raw };

  // Prefix models.*
  if (result.models && typeof result.models === 'object') {
    const models = { ...result.models };
    for (const [key, value] of Object.entries(models)) {
      if (typeof value === 'string') {
        models[key] = prefixModel(value);
      }
    }
    result.models = models;
  }

  // Prefix axes.*.model
  if (result.axes && typeof result.axes === 'object') {
    const axes = { ...result.axes };
    for (const [axisKey, axisValue] of Object.entries(axes)) {
      if (axisValue && typeof axisValue === 'object' && typeof (axisValue as any).model === 'string') {
        axes[axisKey] = { ...(axisValue as any), model: prefixModel((axisValue as any).model) };
      }
    }
    result.axes = axes;
  }

  // Prefix agents.* string values (skip boolean `enabled`)
  if (result.agents && typeof result.agents === 'object') {
    const agents = { ...result.agents };
    for (const [key, value] of Object.entries(agents)) {
      if (typeof value === 'string') {
        agents[key] = prefixModel(value);
      }
    }
    result.agents = agents;
  }

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
      '  Update your config to use `providers`, `models`, `axes` sections.\n' +
      '  Legacy format supported until v2.0.\n\n',
    );
    configObj = migrateConfigV0toV1(configObj);
  }

  // Migrate v1 config (bare model names) to v2 (prefixed)
  if (isV1Config(configObj as Record<string, any>)) {
    process.stderr.write(
      '\n⚠ .anatoly.yml uses bare model names (v1 format).\n' +
      '  Add provider prefixes (e.g. google/gemini-2.5-flash, anthropic/claude-sonnet-4-6).\n' +
      '  Bare model names supported until v3.0.\n\n',
    );
    configObj = migrateConfigV1toV2(configObj as Record<string, any>);
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
