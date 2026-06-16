// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { reconcileActionsWithVerdicts } from './action-reconcile.js';
import type { Action, SymbolReview } from '../../../schemas/review.js';

function sym(overrides: Partial<SymbolReview> = {}): SymbolReview {
  return {
    name: 'X',
    kind: 'function',
    exported: true,
    line_start: 1,
    line_end: 3,
    correction: 'OK',
    overengineering: 'LEAN',
    utility: 'USED',
    duplication: 'UNIQUE',
    tests: 'GOOD',
    documentation: 'DOCUMENTED',
    flow: '-',
    confidence: 80,
    detail: '',
    duplicate_target: undefined,
    ...overrides,
  };
}

function deadAction(target: string, lines = 'L1-L3'): Action {
  return {
    id: 1,
    description: `Remove dead code: \`${target}\` is exported but unused`,
    severity: 'medium',
    effort: 'trivial',
    category: 'refactor',
    source: 'utility',
    target_symbol: target,
    target_lines: lines,
  };
}

describe('reconcileActionsWithVerdicts', () => {
  // --- A.1: grouped utility action after partial DEAD→USED flip ---

  it('rebuilds a grouped barrel action to only the symbols still DEAD', () => {
    // The osteovienne Card barrel: 5 exports resolved USED, CardFooter still DEAD,
    // but the review carries one grouped "Remove dead code: Card, ..., CardFooter".
    const names = ['Card', 'CardHeader', 'CardTitle', 'CardDescription', 'CardContent', 'CardFooter'];
    const symbols = names.map((n) =>
      sym({ name: n, utility: n === 'CardFooter' ? 'DEAD' : 'USED' }),
    );
    const grouped: Action = {
      id: 1,
      description:
        'Remove dead code: `Card` is exported but unused `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`',
      severity: 'medium',
      effort: 'trivial',
      category: 'refactor',
      source: 'utility',
      target_symbol: names.join(', '),
      target_lines: 'L4-L14, L16-L18, L20-L22, L24-L26, L28-L30, L32-L34',
    };

    const out = reconcileActionsWithVerdicts([grouped], symbols);

    const utility = out.filter((a) => a.source === 'utility');
    expect(utility).toHaveLength(1);
    expect(utility[0].target_symbol).toBe('CardFooter');
    expect(utility[0].description).toContain('CardFooter');
    // The USED exports must no longer be named as dead code.
    expect(utility[0].description).not.toContain('CardHeader');
    expect(utility[0].description).not.toMatch(/`Card`/);
  });

  it('drops a grouped action entirely when every target flipped USED', () => {
    const names = ['A', 'B', 'C'];
    const symbols = names.map((n) => sym({ name: n, utility: 'USED' }));
    const grouped: Action = {
      ...deadAction(names.join(', ')),
      description: 'Remove dead code: `A` is exported but unused `A`, `B`, `C`',
    };

    const out = reconcileActionsWithVerdicts([grouped], symbols);

    expect(out.filter((a) => a.source === 'utility')).toHaveLength(0);
  });

  it('keeps a grouped action unchanged when every target is still DEAD', () => {
    const names = ['A', 'B', 'C'];
    const symbols = names.map((n) => sym({ name: n, utility: 'DEAD' }));
    const grouped: Action = {
      ...deadAction(names.join(', ')),
      description: 'Remove dead code: `A` is exported but unused `A`, `B`, `C`',
    };

    const out = reconcileActionsWithVerdicts([grouped], symbols);

    expect(out).toHaveLength(1);
    expect(out[0].target_symbol).toBe('A, B, C');
  });

  // --- A.2: retracted correction action ---

  it('drops a correction action when its symbol was reclassified OK', () => {
    const symbols = [sym({ name: 'DynamicFields', correction: 'OK' })];
    const action: Action = {
      id: 1,
      description: "Audit RichEditor's `minHeight` prop type and usage.",
      severity: 'low',
      effort: 'trivial',
      category: 'refactor',
      source: 'correction',
      target_symbol: 'DynamicFields',
      target_lines: 'L65',
    };

    const out = reconcileActionsWithVerdicts([action], symbols);

    expect(out.filter((a) => a.source === 'correction')).toHaveLength(0);
  });

  it('keeps a correction action while the symbol is still NEEDS_FIX', () => {
    const symbols = [sym({ name: 'buggy', correction: 'NEEDS_FIX' })];
    const action: Action = {
      id: 1,
      description: 'Fix the off-by-one in `buggy`.',
      severity: 'high',
      effort: 'small',
      category: 'refactor',
      source: 'correction',
      target_symbol: 'buggy',
      target_lines: 'L1-L3',
    };

    const out = reconcileActionsWithVerdicts([action], symbols);

    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('correction');
  });

  // --- Conservative / pass-through behaviour ---

  it('keeps an action whose target symbol is unknown (cannot evaluate)', () => {
    const out = reconcileActionsWithVerdicts([deadAction('ghost')], [sym({ name: 'other' })]);
    expect(out).toHaveLength(1);
    expect(out[0].target_symbol).toBe('ghost');
  });

  it('never reconciles a non-verdict-driven source', () => {
    const symbols = [sym({ name: 'x', utility: 'USED' })];
    const action: Action = {
      id: 1,
      description: 'Apply a best-practice rule to `x`.',
      severity: 'medium',
      effort: 'trivial',
      category: 'refactor',
      source: 'best_practices',
      target_symbol: 'x',
      target_lines: 'L1-L1',
    };

    const out = reconcileActionsWithVerdicts([action], symbols);

    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('best_practices');
  });

  it('re-IDs surviving actions sequentially from 1', () => {
    const symbols = [
      sym({ name: 'keep1', utility: 'DEAD' }),
      sym({ name: 'gone', utility: 'USED' }),
      sym({ name: 'keep2', correction: 'NEEDS_FIX' }),
    ];
    const actions: Action[] = [
      { ...deadAction('keep1'), id: 7 },
      { ...deadAction('gone'), id: 8 },
      {
        id: 9, description: 'Fix `keep2`', severity: 'high', effort: 'small', category: 'refactor',
        source: 'correction', target_symbol: 'keep2', target_lines: 'L1-L1',
      },
    ];

    const out = reconcileActionsWithVerdicts(actions, symbols);

    expect(out.map((a) => a.id)).toEqual([1, 2]);
    expect(out.map((a) => a.target_symbol).sort()).toEqual(['keep1', 'keep2']);
  });
});
