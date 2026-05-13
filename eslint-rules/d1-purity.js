// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * ESLint rule: d1-purity
 *
 * Ensures that Zod outputSchema declarations in the primitive registry do not
 * contain forbidden fields that belong to other data planes (D.2 dump, D.3 log,
 * D.4 cost). This prevents prompt/cost/cache leakage into typed exchange data.
 *
 * Forbidden fields: prompt, system, userMessage, toolTurns, durationMs,
 * costUsd, cacheReadTokens, cacheCreationTokens, cacheWriteTokens
 */

const FORBIDDEN_FIELDS = new Set([
  'prompt',
  'system',
  'userMessage',
  'toolTurns',
  'durationMs',
  'costUsd',
  'cacheReadTokens',
  'cacheCreationTokens',
  'cacheWriteTokens',
]);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow forbidden fields in outputSchema Zod declarations',
      recommended: true,
    },
    messages: {
      forbiddenField:
        'Field "{{field}}" is forbidden in outputSchema (D.1 purity). ' +
        'This field belongs to the dump (D.2), log (D.3), or cost (D.4) plane.',
    },
    schema: [],
  },

  create(context) {
    return {
      /**
       * Match: `outputSchema: z.object({ ... })`
       * Look for Property nodes where the key is 'outputSchema' and the value
       * is a z.object() call containing forbidden property names.
       */
      'Property[key.name="outputSchema"] CallExpression[callee.property.name="object"] > ObjectExpression > Property'(
        node,
      ) {
        const key = node.key;
        const fieldName = key.type === 'Identifier' ? key.name : key.value;
        if (typeof fieldName === 'string' && FORBIDDEN_FIELDS.has(fieldName)) {
          context.report({
            node: key,
            messageId: 'forbiddenField',
            data: { field: fieldName },
          });
        }
      },
    };
  },
};

export default rule;
