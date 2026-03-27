// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod v4 introspection helpers
// ---------------------------------------------------------------------------

interface ZodDef {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  entries?: Record<string, string>;
  innerType?: z.ZodType;
  format?: string;
  checks?: ZodCheck[];
}

interface ZodCheck {
  _zod: { def: { check: string; value: number; inclusive: boolean } };
}

function getDef(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

// ---------------------------------------------------------------------------
// Contextual string defaults based on field name hints
// ---------------------------------------------------------------------------

const STRING_HINTS: Record<string, string> = {
  name: 'exampleSymbol',
  detail: 'Explanation of the analysis finding',
  description: 'Explanation of the analysis finding',
  reason: 'Explanation of the verification result',
  file: 'src/example.ts',
  symbol: 'myFunction',
  similarity: 'high structural similarity',
  lines: 'L10-L20',
  before: 'const x = oldValue;',
  after: 'const x = newValue;',
  rule_name: 'error-handling',
  doc_path: 'docs/api.md',
};

const DEFAULT_STRING = 'example text value';

// ---------------------------------------------------------------------------
// generateSchemaExample — produce a minimal valid example from a Zod schema
// ---------------------------------------------------------------------------

/**
 * Produce a minimal valid example value from a Zod schema by recursively
 * walking the schema tree.  String fields are given contextual defaults when
 * {@link hint} matches an entry in the internal `STRING_HINTS` table (e.g.
 * `"file"` yields `"src/example.ts"`).  Numeric fields honour `greater_than`
 * / `less_than` checks and pick a value at 85 % of the range; safe-integers
 * are rounded.  Enum fields return the first declared value.
 *
 * @param schema - The Zod schema to generate an example for.
 * @param hint   - Optional field-name hint used to select a contextual string
 *                 default (ignored for non-string schemas).
 * @returns A plain JS value that satisfies {@link schema}.
 */
export function generateSchemaExample(schema: z.ZodType, hint?: string): unknown {
  const def = getDef(schema);

  switch (def.type) {
    case 'object': {
      const result: Record<string, unknown> = {};
      if (def.shape) {
        for (const [key, valueSchema] of Object.entries(def.shape)) {
          result[key] = generateSchemaExample(valueSchema, key);
        }
      }
      return result;
    }

    case 'array':
      return def.element ? [generateSchemaExample(def.element)] : [];

    case 'string':
      return (hint && STRING_HINTS[hint]) ?? DEFAULT_STRING;

    case 'number': {
      const isInt = def.format === 'safeint';
      let min: number | undefined;
      let max: number | undefined;
      let minInclusive = true;
      let maxInclusive = true;
      for (const check of def.checks ?? []) {
        const c = check._zod.def;
        if (c.check === 'greater_than') { min = c.value; minInclusive = c.inclusive; }
        if (c.check === 'less_than') { max = c.value; maxInclusive = c.inclusive; }
      }
      const eps = isInt ? 1 : Number.EPSILON * 2;
      if (min !== undefined && max !== undefined) {
        const lo = minInclusive ? min : min + eps;
        const hi = maxInclusive ? max : max - eps;
        const value = lo + (hi - lo) * 0.85;
        return isInt ? Math.round(value) : Math.round(value * 10) / 10;
      }
      if (min !== undefined) return minInclusive ? min : min + eps;
      if (max !== undefined) return maxInclusive ? max : max - eps;
      return isInt ? 1 : 1.0;
    }

    case 'enum': {
      const values = Object.values(def.entries ?? {});
      return values[0] ?? '';
    }

    case 'boolean':
      return true;

    case 'literal':
      return (def as unknown as { value: unknown }).value ?? null;

    case 'optional':
    case 'default':
    case 'nullable':
      return def.innerType ? generateSchemaExample(def.innerType, hint) : null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Enum annotation collection
// ---------------------------------------------------------------------------

interface EnumAnnotation {
  firstValue: string;
  allValues: string[];
}

/**
 * Recursively traverse a Zod schema and collect every enum annotation
 * (first declared value plus the full value list).  A `seen` set prevents
 * infinite loops when the schema contains cycles.
 *
 * @param schema - Root Zod schema to traverse.
 * @param seen   - Accumulator of already-visited schema nodes (used
 *                 internally for cycle detection).
 * @returns Array of {@link EnumAnnotation} objects found in the tree.
 */
function collectEnums(schema: z.ZodType, seen = new Set<z.ZodType>()): EnumAnnotation[] {
  if (seen.has(schema)) return [];
  seen.add(schema);

  const def = getDef(schema);
  const result: EnumAnnotation[] = [];

  switch (def.type) {
    case 'object':
      if (def.shape) {
        for (const valueSchema of Object.values(def.shape)) {
          result.push(...collectEnums(valueSchema, seen));
        }
      }
      break;

    case 'array':
      if (def.element) {
        result.push(...collectEnums(def.element, seen));
      }
      break;

    case 'enum': {
      const values = Object.values(def.entries ?? {});
      if (values.length > 0) {
        result.push({ firstValue: values[0], allValues: values });
      }
      break;
    }

    case 'optional':
    case 'default':
    case 'nullable':
      if (def.innerType) {
        result.push(...collectEnums(def.innerType, seen));
      }
      break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// formatSchemaExample — JSON string with inline enum comments
// ---------------------------------------------------------------------------

/**
 * Generate a pretty-printed JSON example from a Zod schema with inline
 * comments listing every allowed enum value.  Enum values that share the
 * same first entry are deduplicated so that only the first occurrence is
 * annotated.
 *
 * @param schema - The Zod schema to format.
 * @returns A JSON string with `// value1 | value2 | ...` comments appended
 *          to lines containing enum values.
 */
export function formatSchemaExample(schema: z.ZodType): string {
  const example = generateSchemaExample(schema);
  const enums = collectEnums(schema);
  const json = JSON.stringify(example, null, 2);

  if (enums.length === 0) return json;

  // Deduplicate: same firstValue → keep first occurrence
  const enumMap = new Map<string, string[]>();
  for (const { firstValue, allValues } of enums) {
    if (!enumMap.has(firstValue)) {
      enumMap.set(firstValue, allValues);
    }
  }

  const lines = json.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [firstValue, allValues] of enumMap) {
      const valueStr = `"${firstValue}"`;
      if (lines[i].includes(`: ${valueStr}`)) {
        const comment = `${valueStr}  // ${allValues.join(' | ')}`;
        lines[i] = lines[i].replace(valueStr, comment);
        break;
      }
    }
  }

  return lines.join('\n');
}
