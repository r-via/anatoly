// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Validation tests for invariants that survive the v1→v2 migration removal.
 * The migration helpers themselves were retired with the v3 cleanup; this
 * file keeps the standalone package-shape assertions.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Google/Gemini provider package removal', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
  const removed = ['@google/genai', '@google/gemini-cli-core', '@ai-sdk/google'];

  it.each(removed)('%s is not listed in dependencies', (name) => {
    expect(pkg.dependencies?.[name]).toBeUndefined();
  });

  it.each(removed)('%s is not listed in devDependencies', (name) => {
    expect(pkg.devDependencies?.[name]).toBeUndefined();
  });
});
