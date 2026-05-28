// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { setAxisSegment, getAxisSegmentText } from './detail-segment.js';

describe('setAxisSegment', () => {
  it('replaces only the targeted axis segment, preserving the others', () => {
    const before = '[DEAD] No importers found | [OVER] Bloated class | [NONE] No test file';
    const after = setAxisSegment(before, 'DEAD', 'USED', 'Auto-resolved: 2 importers');
    expect(after).toBe('[USED] Auto-resolved: 2 importers | [OVER] Bloated class | [NONE] No test file');
  });

  it('appends a new segment when the from-tag is absent', () => {
    const before = '[OVER] Bloated class | [NONE] No test file';
    const after = setAxisSegment(before, 'DEAD', 'USED', 'Auto-resolved: 2 importers');
    expect(after).toBe('[OVER] Bloated class | [NONE] No test file | [USED] Auto-resolved: 2 importers');
  });

  it('only replaces the first matching segment (idempotent on multi-tag corruption)', () => {
    const before = '[DEAD] first | [DEAD] second';
    const after = setAxisSegment(before, 'DEAD', 'USED', 'fixed');
    expect(after).toBe('[USED] fixed | [DEAD] second');
  });

  it('handles a single-segment detail without spurious splits', () => {
    const before = '[DEAD] only one';
    const after = setAxisSegment(before, 'DEAD', 'USED', 'now used');
    expect(after).toBe('[USED] now used');
  });

  it('handles the axis-crashed default segment shape', () => {
    // axis-merger emits this exact wording when an axis crashed
    const before = '[DEAD] orphan export | [NEEDS_FIX] *(axis crashed — see transcript)*';
    const after = setAxisSegment(before, 'DEAD', 'USED', 'now imported');
    expect(after).toBe('[USED] now imported | [NEEDS_FIX] *(axis crashed — see transcript)*');
  });
});

describe('getAxisSegmentText', () => {
  it('returns the rationale stripped of the verdict tag', () => {
    const detail = '[DEAD] No importers found | [OVER] Bloated class';
    expect(getAxisSegmentText(detail, 'DEAD')).toBe('No importers found');
    expect(getAxisSegmentText(detail, 'OVER')).toBe('Bloated class');
  });

  it('returns undefined when the tag is absent', () => {
    expect(getAxisSegmentText('[USED] foo', 'DEAD')).toBeUndefined();
  });

  it('returns undefined on an empty string', () => {
    expect(getAxisSegmentText('', 'USED')).toBeUndefined();
  });
});
