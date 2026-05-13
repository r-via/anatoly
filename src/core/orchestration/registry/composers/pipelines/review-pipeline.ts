// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import type { ComposerEntry } from '../types.js';

const AXIS_IDS = [
  'utility',
  'duplication',
  'correction',
  'overengineering',
  'tests',
  'best-practices',
  'documentation',
] as const;

export const reviewPipelineComposer: ComposerEntry = {
  name: 'review-pipeline',
  plan: {
    steps: [
      // Fan-out: 7 axis composers run in parallel (no mutual dependencies)
      ...AXIS_IDS.map((axis) => ({
        id: axis,
        composer: `axes.${axis}`,
      })),
      // Merger: reads from all 7, produces unified output
      {
        id: 'axis-merger',
        readsFrom: [...AXIS_IDS],
        inputMapper: (exchange) => {
          const merged: Record<string, unknown> = {};
          for (const axis of AXIS_IDS) {
            if (exchange.has(axis)) {
              merged[axis] = exchange.read(axis, z.any());
            }
          }
          return merged;
        },
      },
    ],
  },
  inputSchema: z.any(),
  outputSchema: z.any(),
};
