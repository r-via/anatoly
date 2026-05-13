// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Story 56.10 — KPI 6: Four-artefact separation regression tests.
 *
 * Validates that the four-block contract (D.1 response, D.2 dump,
 * D.3 log, D.4 cost) declared in each primitive enforces clean
 * separation of concerns. No artefact should leak fields that belong
 * to another artefact.
 */

import { describe, it, expect } from 'vitest';
import { PRIMITIVES } from './registry/primitives/index.js';
import {
  FORBIDDEN_OUTPUT_FIELDS,
  DUMP_LOCATION_TEMPLATE,
} from './registry/primitives/types.js';

// ---------------------------------------------------------------------------
// KPI 6a: D.1 (response/exchange) — outputSchema excludes forbidden fields
// ---------------------------------------------------------------------------

describe('KPI 6a: D.1 outputSchema excludes forbidden fields', () => {
  for (const [name, primitive] of PRIMITIVES) {
    it(`primitive "${name}" outputSchema has no forbidden fields`, () => {
      const schema = primitive.response.outputSchema;
      // If the schema has a .shape property (ZodObject), inspect its keys
      const shape = (schema as { shape?: Record<string, unknown> }).shape;
      if (shape) {
        const keys = Object.keys(shape);
        for (const forbidden of FORBIDDEN_OUTPUT_FIELDS) {
          expect(keys, `"${name}" outputSchema contains forbidden field "${forbidden}"`).not.toContain(forbidden);
        }
      }
      // Non-object schemas (z.any(), z.unknown()) are acceptable for D.1
    });
  }
});

// ---------------------------------------------------------------------------
// KPI 6b: D.2 (dump) — uses canonical location template
// ---------------------------------------------------------------------------

describe('KPI 6b: D.2 dump location uses canonical template', () => {
  for (const [name, primitive] of PRIMITIVES) {
    if (primitive.dump.enabled) {
      it(`primitive "${name}" dump location matches canonical template`, () => {
        expect(primitive.dump.location).toBe(DUMP_LOCATION_TEMPLATE);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// KPI 6c: D.2 (dump) — format is either markdown or json
// ---------------------------------------------------------------------------

describe('KPI 6c: D.2 dump format is valid', () => {
  for (const [name, primitive] of PRIMITIVES) {
    it(`primitive "${name}" dump format is 'markdown' or 'json'`, () => {
      expect(['markdown', 'json']).toContain(primitive.dump.format);
    });
  }
});

// ---------------------------------------------------------------------------
// KPI 6d: D.4 (cost) — pricingModel is a known value
// ---------------------------------------------------------------------------

describe('KPI 6d: D.4 cost pricingModel is a known value', () => {
  for (const [name, primitive] of PRIMITIVES) {
    it(`primitive "${name}" cost pricingModel is 'api-token-based'`, () => {
      // Currently the only known pricing model
      expect(primitive.cost.pricingModel).toBe('api-token-based');
    });
  }
});

// ---------------------------------------------------------------------------
// KPI 6e: D.4 (cost) — capture is 'actual' or 'unknown'
// ---------------------------------------------------------------------------

describe('KPI 6e: D.4 cost capture is valid', () => {
  for (const [name, primitive] of PRIMITIVES) {
    it(`primitive "${name}" cost capture is 'actual' or 'unknown'`, () => {
      expect(['actual', 'unknown']).toContain(primitive.cost.capture);
    });
  }
});

// ---------------------------------------------------------------------------
// KPI 6f: D.3 (log) — no log block leaks full prompt or response fields
// ---------------------------------------------------------------------------

describe('KPI 6f: D.3 log block has no forbidden leak fields', () => {
  const LOG_FORBIDDEN = ['prompt', 'system', 'assistantResponse', 'cacheReadTokens', 'pricingModel', 'estimatedUsd'];

  for (const [name, primitive] of PRIMITIVES) {
    it(`primitive "${name}" log block extraFields have no forbidden keys`, () => {
      const extra = primitive.log.extraFields;
      if (extra) {
        const keys = Object.keys(extra);
        for (const forbidden of LOG_FORBIDDEN) {
          expect(keys, `"${name}" log extraFields contains "${forbidden}"`).not.toContain(forbidden);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// KPI 6g: Structural — every primitive has all four blocks
// ---------------------------------------------------------------------------

describe('KPI 6g: every primitive declares all four blocks', () => {
  for (const [name, primitive] of PRIMITIVES) {
    it(`primitive "${name}" has response, dump, log, and cost blocks`, () => {
      expect(primitive.response).toBeDefined();
      expect(primitive.dump).toBeDefined();
      expect(primitive.log).toBeDefined();
      expect(primitive.cost).toBeDefined();
    });
  }
});
