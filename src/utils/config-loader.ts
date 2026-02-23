import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { ConfigSchema } from '../schemas/config.js';
import type { Config } from '../schemas/config.js';
import { AnatolyError, ERROR_CODES } from './errors.js';

const CONFIG_FILENAME = '.anatoly.yml';

/**
 * Load Anatoly configuration from `.anatoly.yml` in the given directory.
 * Falls back to sensible defaults if no config file exists.
 * Throws AnatolyError CONFIG_INVALID for malformed YAML or invalid config.
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
    );
  }

  // yaml.load returns undefined for empty files, null for "null" content
  if (parsed == null) {
    return ConfigSchema.parse({});
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new AnatolyError(
      `Invalid configuration in ${filePath}:\n${issues}`,
      ERROR_CODES.CONFIG_INVALID,
      false,
    );
  }

  return result.data;
}
