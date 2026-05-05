// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { ConfigSchema } from '../schemas/config.js';
import type { Config } from '../schemas/config.js';
import { ConfigV3Schema, isV3Config, type ConfigV3 } from '../schemas/config-v3.js';
import { adaptV3ToV2 } from '../schemas/config-v3-adapter.js';
import { AnatolyError, ERROR_CODES } from './errors.js';

/**
 * Hidden property where `loadConfig` stashes the original parsed v3 config
 * (when the YAML used `version: 3`). Consumers that want the raw v3 — to read
 * provider transport metadata, declared model lists, etc. — should call
 * {@link getV3Source} rather than dereference the symbol directly. The
 * property is non-enumerable so it doesn't leak into JSON / Object.entries.
 */
const V3_SOURCE: unique symbol = Symbol.for('anatoly.config.v3Source');

/**
 * Retrieve the original v3 config that produced this `Config`, or `undefined`
 * if the input YAML wasn't a v3 (legacy v0/v1/v2 path). Helpers that need v3-
 * specific data (e.g. the strict per-provider model list, transport metadata)
 * use this to switch behaviour without changing their callers' signatures.
 */
export function getV3Source(config: Config): ConfigV3 | undefined {
  return (config as unknown as Record<symbol, unknown>)[V3_SOURCE] as ConfigV3 | undefined;
}

const CONFIG_FILENAME = '.anatoly.yml';

/**
 * Load Anatoly configuration from `.anatoly.yml` in the given directory.
 * Falls back to sensible defaults if no config file exists.
 *
 * Two formats are accepted:
 * - **v3** (`version: 3`): the declarative schema in
 *   {@link ConfigV3Schema} — validated strictly, then adapted to the v2
 *   internal shape so existing consumers see the same `Config` object. The
 *   raw v3 source is stashed on a hidden Symbol; helpers retrieve it via
 *   {@link getV3Source} when they need declarative metadata.
 * - **v2 prefixed** (no `version:`): the historic shape with
 *   `providers`, `models.quality` etc. — accepted as-is by `ConfigSchema`.
 *   Used by internal consumers that haven't been migrated to v3 yet.
 *
 * Throws {@link AnatolyError} (`CONFIG_INVALID`) for malformed YAML, invalid
 * v3, or invalid v2 configs.
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

  // v3 config (declarative `version: 3` schema): validate strictly, then adapt
  // back to the v2 shape so all downstream consumers continue to work without
  // changes. Phase B preserves this bridge until the consumers are migrated.
  if (isV3Config(parsed)) {
    const v3Result = ConfigV3Schema.safeParse(parsed);
    if (!v3Result.success) {
      const issues = v3Result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      const firstKey = v3Result.error.issues[0]?.path.join('.') ?? 'unknown';
      throw new AnatolyError(
        `Invalid v3 configuration in ${filePath}:\n${issues}`,
        ERROR_CODES.CONFIG_INVALID,
        false,
        `fix the \`${firstKey}\` key in ${filePath} — see v3 schema in src/schemas/config-v3.ts`,
      );
    }
    const adapted = adaptV3ToV2(v3Result.data);
    const finalConfig = ConfigSchema.parse(adapted);
    // Stash a structured clone of the v3 source so consumer-side mutations
    // don't bleed into zod's `.default(...)` shared object references.
    const v3Snapshot = structuredClone(v3Result.data);
    Object.defineProperty(finalConfig, V3_SOURCE, {
      value: v3Snapshot,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return finalConfig;
  }

  const result = ConfigSchema.safeParse(parsed);
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
