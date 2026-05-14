// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import yaml from 'js-yaml';
import { anatolyPath } from '../utils/anatoly-paths.js';
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
// Paths
// ---------------------------------------------------------------------------

/**
 * Resolve the path to this project's preferences file:
 * `<projectRoot>/.anatoly/setup/preferences.yml`.
 *
 * Preferences are project-local on purpose — a tier choice that fits one
 * codebase (e.g. advanced GGUF on a large Go monorepo) shouldn't silently
 * apply to every other project on the same machine.
 */
export function prefsFilePath(projectRoot: string): string {
  return anatolyPath(projectRoot, 'setup', 'preferences.yml');
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load project-local preferences from
 * `<projectRoot>/.anatoly/setup/preferences.yml`.
 *
 * Returns `null` when:
 * - the file does not exist (first-ever run in this project)
 * - the YAML is invalid or unparseable (logged as warn)
 * - the parsed result is not an object
 */
export function loadPreferences(projectRoot: string): Preferences | null {
  try {
    const raw = readFileSync(prefsFilePath(projectRoot), 'utf-8');
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
 * Persist project-local preferences to
 * `<projectRoot>/.anatoly/setup/preferences.yml`.
 *
 * Best-effort: logs a warning on failure but never throws.
 */
export function savePreferences(projectRoot: string, prefs: Preferences): void {
  try {
    const path = prefsFilePath(projectRoot);
    mkdirSync(anatolyPath(projectRoot, 'setup'), { recursive: true });
    const yamlStr = yaml.dump(prefs, { lineWidth: 120 });
    writeFileSync(path, yamlStr, 'utf-8');
  } catch (err) {
    getLogger().warn({ err }, 'Could not save preference');
  }
}
