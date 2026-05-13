// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * ESLint rule: d3-event-purity
 *
 * Ensures that pino structured-log event objects (any `.info()`, `.warn()`,
 * `.error()` call whose first argument is an object literal with an `event`
 * property) do not contain fields that belong to other data planes:
 *
 *   - D.2 (dump): prompt, system, userMessage, toolTurns, assistantResponse
 *   - D.4 (cost): cacheReadTokens, cacheCreationTokens, costSource,
 *                  pricingModel, estimatedUsd
 *
 * Headline cost stats (costUsd, inputTokens, outputTokens, cacheHit boolean)
 * ARE allowed in D.3 events.
 */

const FORBIDDEN_FIELDS = new Set([
  'prompt',
  'system',
  'userMessage',
  'toolTurns',
  'assistantResponse',
  'cacheReadTokens',
  'cacheCreationTokens',
  'costSource',
  'pricingModel',
  'estimatedUsd',
]);

const LOG_METHODS = new Set(['info', 'warn', 'error', 'debug', 'fatal', 'trace']);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow forbidden fields in pino event objects (D.3 event purity)',
      recommended: true,
    },
    messages: {
      forbiddenField:
        'Field "{{field}}" is forbidden in D.3 event objects. ' +
        'This field belongs to the dump (D.2) or cost (D.4) plane.',
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (callee.property.type !== 'Identifier') return;
        if (!LOG_METHODS.has(callee.property.name)) return;

        const firstArg = node.arguments[0];
        if (!firstArg || firstArg.type !== 'ObjectExpression') return;

        // Only inspect event objects (those with an `event` property)
        const hasEventField = firstArg.properties.some(
          (prop) =>
            prop.type === 'Property' &&
            prop.key.type === 'Identifier' &&
            prop.key.name === 'event',
        );
        if (!hasEventField) return;

        for (const prop of firstArg.properties) {
          if (prop.type !== 'Property') continue;
          const key = prop.key;
          const fieldName = key.type === 'Identifier' ? key.name : key.value;
          if (typeof fieldName === 'string' && FORBIDDEN_FIELDS.has(fieldName)) {
            context.report({
              node: key,
              messageId: 'forbiddenField',
              data: { field: fieldName },
            });
          }
        }
      },
    };
  },
};

export default rule;
