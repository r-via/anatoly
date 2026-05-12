// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Minimal valid fixtures for tests that need a parseable Config but don't
 * exercise the documentation pipeline. These exist solely because Story 54.1
 * removed schema-level defaults on `documentation` (no-magic principle); test
 * fixtures that previously relied on those defaults now provide this block
 * explicitly via spread.
 *
 * Usage (v2 / ConfigSchema):
 *   ConfigSchema.parse({ documentation: MIN_VALID_DOC_CONFIG, ...overrides });
 *
 * Usage (v3 / ConfigV3Schema):
 *   ConfigV3Schema.parse({ ..., evaluation: { axes: { documentation: MIN_VALID_V3_DOC_AXIS } } });
 *
 * DO NOT use these in production code paths — they bypass the wizard's
 * intentional friction. Only acceptable in unit tests that don't care
 * about doc configuration.
 */

export const MIN_VALID_DOC_CONFIG = {
  reference: {
    paths: ['README.md'],
    inline_comments: { enabled: false },
  },
  internal: { mode: 'off' as const },
};

export const MIN_VALID_V3_DOC_AXIS = {
  enabled: true,
  reference: {
    paths: ['README.md'],
    inline_comments: { enabled: false },
  },
  internal: { mode: 'off' as const },
};

import { ConfigSchema, type Config } from './config.js';

/**
 * Test wrapper around ConfigSchema.parse that injects a minimal valid
 * documentation block when overrides don't provide one. Use this in tests
 * where the doc config is not the subject under test.
 *
 * Mirrors the wizard's behavior: writes an explicit (but harmless) doc
 * config so the strict ConfigSchema is satisfied without any schema-level
 * default magic in production.
 */
export function parseTestConfig(overrides: Record<string, unknown> = {}): Config {
  const merged: Record<string, unknown> = {
    documentation: MIN_VALID_DOC_CONFIG,
    ...overrides,
  };
  return ConfigSchema.parse(merged);
}
