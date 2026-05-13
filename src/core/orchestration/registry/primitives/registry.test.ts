// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { PRIMITIVES } from './index.js';
import { KNOWN_PRICING_MODELS, FORBIDDEN_OUTPUT_FIELDS } from './types.js';
import type { PrimitiveEntry } from './types.js';

// ---------------------------------------------------------------------------
// Expected registry contents
// ---------------------------------------------------------------------------

const EXPECTED_AXIS_PRIMITIVES = [
  'axes.utility',
  'axes.duplication',
  'axes.correction-pass1',
  'axes.correction-verify',
  'axes.overengineering',
  'axes.tests',
  'axes.best-practices',
  'axes.documentation',
];

const EXPECTED_RAG_PRIMITIVES = ['rag.nlp-summary', 'rag.doc-chunk'];

const EXPECTED_AGENTIC_PRIMITIVES = [
  'agents.doc-conflict-detector',
  'agents.doc-generator',
  'agents.tier3-deliberator',
  'agents.vercel-agent',
];

const ALL_EXPECTED = [
  ...EXPECTED_AXIS_PRIMITIVES,
  ...EXPECTED_RAG_PRIMITIVES,
  ...EXPECTED_AGENTIC_PRIMITIVES,
];

// ---------------------------------------------------------------------------
// Helper to extract Zod object keys (if the schema is a ZodObject)
// ---------------------------------------------------------------------------

function getZodObjectKeys(schema: unknown): string[] {
  if (
    schema &&
    typeof schema === 'object' &&
    'shape' in schema &&
    typeof (schema as Record<string, unknown>).shape === 'object'
  ) {
    return Object.keys((schema as { shape: Record<string, unknown> }).shape);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Primitive Registry', () => {
  // -----------------------------------------------------------------------
  // Registry completeness
  // -----------------------------------------------------------------------

  describe('registry completeness', () => {
    it('should contain all expected axis primitives', () => {
      for (const name of EXPECTED_AXIS_PRIMITIVES) {
        expect(PRIMITIVES.has(name), `missing: ${name}`).toBe(true);
      }
    });

    it('should contain all expected RAG primitives', () => {
      for (const name of EXPECTED_RAG_PRIMITIVES) {
        expect(PRIMITIVES.has(name), `missing: ${name}`).toBe(true);
      }
    });

    it('should contain all expected agentic primitives', () => {
      for (const name of EXPECTED_AGENTIC_PRIMITIVES) {
        expect(PRIMITIVES.has(name), `missing: ${name}`).toBe(true);
      }
    });

    it('should have the correct total count', () => {
      expect(PRIMITIVES.size).toBe(ALL_EXPECTED.length);
    });
  });

  // -----------------------------------------------------------------------
  // Name field matches map key
  // -----------------------------------------------------------------------

  describe('name field matches map key', () => {
    it.each(ALL_EXPECTED)('primitive "%s" name matches its map key', (name) => {
      const entry = PRIMITIVES.get(name)!;
      expect(entry.name).toBe(name);
    });
  });

  // -----------------------------------------------------------------------
  // Four-block contract is non-empty
  // -----------------------------------------------------------------------

  describe('four-block contract', () => {
    it.each(ALL_EXPECTED)(
      'primitive "%s" has a non-empty four-block contract',
      (name) => {
        const entry = PRIMITIVES.get(name)!;

        // D.1 response
        expect(entry.response).toBeDefined();
        expect(entry.response.schema).toBeDefined();
        expect(entry.response.outputSchema).toBeDefined();

        // D.2 dump
        expect(entry.dump).toBeDefined();
        expect(typeof entry.dump.enabled).toBe('boolean');
        expect(entry.dump.format).toMatch(/^(markdown|json)$/);
        expect(entry.dump.location).toBeTruthy();

        // D.3 log
        expect(entry.log).toBeDefined();

        // D.4 cost
        expect(entry.cost).toBeDefined();
        expect(entry.cost.pricingModel).toBeTruthy();
        expect(entry.cost.capture).toMatch(/^(actual|unknown)$/);
      },
    );
  });

  // -----------------------------------------------------------------------
  // estimateCost returns positive numbers
  // -----------------------------------------------------------------------

  describe('estimateCost', () => {
    it.each(ALL_EXPECTED)(
      'primitive "%s" estimateCost returns positive inputTokens/outputTokens',
      (name) => {
        const entry = PRIMITIVES.get(name)!;
        const estimate = entry.estimateCost({ inputChars: 5000, itemCount: 5 });
        expect(estimate.inputTokens).toBeGreaterThan(0);
        expect(estimate.outputTokens).toBeGreaterThan(0);
      },
    );
  });

  // -----------------------------------------------------------------------
  // pricingModel matches known refs
  // -----------------------------------------------------------------------

  describe('pricingModel', () => {
    it.each(ALL_EXPECTED)(
      'primitive "%s" has a known pricingModel',
      (name) => {
        const entry = PRIMITIVES.get(name)!;
        expect(
          (KNOWN_PRICING_MODELS as readonly string[]).includes(
            entry.cost.pricingModel,
          ),
        ).toBe(true);
      },
    );
  });

  // -----------------------------------------------------------------------
  // Type correctness
  // -----------------------------------------------------------------------

  describe('primitive types', () => {
    it('axis primitives are single-turn', () => {
      for (const name of EXPECTED_AXIS_PRIMITIVES) {
        expect(PRIMITIVES.get(name)!.type).toBe('single-turn');
      }
    });

    it('RAG primitives are single-turn', () => {
      for (const name of EXPECTED_RAG_PRIMITIVES) {
        expect(PRIMITIVES.get(name)!.type).toBe('single-turn');
      }
    });

    it('agentic primitives are agentic', () => {
      for (const name of EXPECTED_AGENTIC_PRIMITIVES) {
        expect(PRIMITIVES.get(name)!.type).toBe('agentic');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Identity fields
  // -----------------------------------------------------------------------

  describe('identity fields', () => {
    it.each(ALL_EXPECTED)(
      'primitive "%s" has valid identity fields',
      (name) => {
        const entry = PRIMITIVES.get(name)!;
        expect(typeof entry.modelResolver).toBe('function');
        expect(entry.prompt).toBeDefined();
        expect(entry.prompt.kind).toMatch(/^(builder|template)$/);
      },
    );
  });

  // -----------------------------------------------------------------------
  // D.1 purity — outputSchema must not contain forbidden fields
  // -----------------------------------------------------------------------

  describe('D.1 outputSchema purity', () => {
    it.each(ALL_EXPECTED)(
      'primitive "%s" outputSchema has no forbidden fields',
      (name) => {
        const entry = PRIMITIVES.get(name)!;
        const keys = getZodObjectKeys(entry.response.outputSchema);
        for (const forbidden of FORBIDDEN_OUTPUT_FIELDS) {
          expect(keys).not.toContain(forbidden);
        }
      },
    );
  });
});
