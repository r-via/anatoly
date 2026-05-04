// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { getLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Preferences {
  embeddings?: {
    prefer?: 'lite' | 'advanced';
  };
}

// ---------------------------------------------------------------------------
// Paths (lazy — must not call homedir() at module load time for testability)
// ---------------------------------------------------------------------------

function prefsDir(): string {
  return resolve(homedir(), '.anatoly');
}

export function prefsFilePath(): string {
  return resolve(prefsDir(), 'preferences.yml');
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load cross-project preferences from `~/.anatoly/preferences.yml`.
 *
 * Returns `null` when:
 * - the file does not exist (first-ever run)
 * - the YAML is invalid or unparseable (logged as warn)
 * - the parsed result is not an object
 */
export function loadPreferences(): Preferences | null {
  try {
    const raw = readFileSync(prefsFilePath(), 'utf-8');
    const parsed = yaml.load(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Preferences;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    getLogger().warn({ err }, 'could not read preferences.yml — ignoring');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Persist cross-project preferences to `~/.anatoly/preferences.yml`.
 *
 * Best-effort: logs a warning on failure but never throws.
 */
export function savePreferences(prefs: Preferences): void {
  try {
    mkdirSync(prefsDir(), { recursive: true });
    const yamlStr = yaml.dump(prefs, { lineWidth: 120 });
    writeFileSync(prefsFilePath(), yamlStr, 'utf-8');
  } catch (err) {
    getLogger().warn({ err }, 'Could not save preference');
  }
}
