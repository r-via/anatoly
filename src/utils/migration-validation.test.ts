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

describe('@google/genai removal', () => {
  it('is not listed in package.json dependencies', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.dependencies?.['@google/genai']).toBeUndefined();
  });

  it('is not listed in package.json devDependencies', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.devDependencies?.['@google/genai']).toBeUndefined();
  });
});
