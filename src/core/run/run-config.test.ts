// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { resolveDocMode } from './run-config.js';
import { parseTestConfig } from '../../schemas/test-fixtures.js';
import { ConfigSchema } from '../../schemas/config.js';

describe('resolveDocMode', () => {
  it('returns "off" when documentation.internal.mode is "off"', () => {
    const config = parseTestConfig({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: { mode: 'off' },
      },
    });
    expect(resolveDocMode(config)).toBe('off');
  });

  it('returns "lite" when documentation.internal.mode is "lite"', () => {
    const config = parseTestConfig({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: {
          mode: 'lite',
          lite: { max_tokens: 4000, refresh_on: ['code_change'] },
        },
      },
    });
    expect(resolveDocMode(config)).toBe('lite');
  });

  it('returns "full" when documentation.internal.mode is "full"', () => {
    const config = parseTestConfig({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: {
          mode: 'full',
          full: { sync_to_repo: false },
        },
      },
    });
    expect(resolveDocMode(config)).toBe('full');
  });

  it('returns a strict union type (no undefined, no generic string)', () => {
    const config = parseTestConfig({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: { mode: 'off' },
      },
    });
    const result = resolveDocMode(config);
    // The result must be one of the three valid values — never undefined
    expect(['off', 'lite', 'full']).toContain(result);
    expect(result).toBeDefined();
  });

  it('throws Zod error when documentation.internal.mode is absent', () => {
    expect(() => {
      ConfigSchema.parse({
        documentation: {
          reference: { paths: ['README.md'], inline_comments: { enabled: false } },
          internal: {},
        },
      });
    }).toThrow();
  });

  it('throws Zod error when documentation section is absent', () => {
    expect(() => {
      ConfigSchema.parse({});
    }).toThrow();
  });
});
