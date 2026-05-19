// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  buildPairDetectionUserMessage,
  DETECTION_SYSTEM_PROMPT,
} from './doc-conflict-llm.js';
import type { CandidatePair } from './doc-conflict-pairing.js';

// ---------------------------------------------------------------------------
// DETECTION_SYSTEM_PROMPT sanity check
// ---------------------------------------------------------------------------

describe('Story 55.10 — DETECTION_SYSTEM_PROMPT', () => {
  it('mentions the three input sources and the output JSON contract', () => {
    expect(DETECTION_SYSTEM_PROMPT).toContain('REFERENCE_DOCS');
    expect(DETECTION_SYSTEM_PROMPT).toContain('INTERNAL_DOCS');
    expect(DETECTION_SYSTEM_PROMPT).toContain('CODE_SURFACE');
    expect(DETECTION_SYSTEM_PROMPT).toContain('JSON');
    expect(DETECTION_SYSTEM_PROMPT).toContain('conflicts');
  });

  it('explicitly excludes stylistic differences and paraphrasings', () => {
    expect(DETECTION_SYSTEM_PROMPT.toLowerCase()).toContain('stylistic');
    expect(DETECTION_SYSTEM_PROMPT.toLowerCase()).toContain('paraphrasing');
  });

  // doc 16 PR 2
  it('makes inversions the highest-priority divergence and explains segmentation', () => {
    expect(DETECTION_SYSTEM_PROMPT.toLowerCase()).toContain('inversion');
    expect(DETECTION_SYSTEM_PROMPT).toContain('reversed sign, direction, ratio, comparator, beneficiary, or unit');
    expect(DETECTION_SYSTEM_PROMPT.toLowerCase()).toContain('segmented by section');
  });
});

// ---------------------------------------------------------------------------
// doc 16 PR 2b — buildPairDetectionUserMessage
// ---------------------------------------------------------------------------

describe('doc 16 PR 2b — buildPairDetectionUserMessage', () => {
  const pair: CandidatePair = {
    ref: { filePath: 'README.md', heading: 'RTP', content: 'house edge of 5% against the player', neighbor: 'ref neighbour text' },
    internal: { filePath: '05-modules/engine.md', heading: 'RTP', content: 'multiplied by 1.05 in the player favour', neighbor: 'int neighbour text' },
    score: 0.91,
  };

  it('emits one labelled pair with both passages, neighbours and CODE_SURFACE', () => {
    const msg = buildPairDetectionUserMessage({ pairs: [pair], codeSurface: '### src/engine.ts\n- function `spin`' });
    expect(msg).toContain('## MATCHED_PASSAGE_PAIRS');
    expect(msg).toContain('### Pair 1');
    expect(msg).toContain('REFERENCE_PASSAGE — `README.md` § RTP');
    expect(msg).toContain('INTERNAL_PASSAGE — `05-modules/engine.md` § RTP');
    expect(msg).toContain('house edge of 5% against the player');
    expect(msg).toContain('multiplied by 1.05 in the player favour');
    expect(msg).toContain('ref neighbour text');
    expect(msg).toContain('int neighbour text');
    expect(msg).toContain('## CODE_SURFACE');
    expect(msg).toContain('function `spin`');
    expect(msg).toContain('"conflicts"');
  });

  it('includes the known-conflicts section only when provided', () => {
    const withKnown = buildPairDetectionUserMessage({ pairs: [pair], codeSurface: 's', knownConflictDescriptions: ['id=abc'] });
    expect(withKnown).toContain('## ALREADY_KNOWN_CONFLICTS');
    expect(withKnown).toContain('id=abc');
    const without = buildPairDetectionUserMessage({ pairs: [pair], codeSurface: 's' });
    expect(without).not.toContain('ALREADY_KNOWN_CONFLICTS');
  });

  it('numbers multiple pairs', () => {
    const msg = buildPairDetectionUserMessage({ pairs: [pair, pair], codeSurface: 's' });
    expect(msg).toContain('### Pair 1');
    expect(msg).toContain('### Pair 2');
  });
});
