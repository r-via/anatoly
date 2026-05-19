// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectInternalDocFragments,
  buildDetectionUserMessage,
  buildPairDetectionUserMessage,
  parseDetectionResponse,
  segmentForDetection,
  DETECTION_SYSTEM_PROMPT,
} from './doc-conflict-llm.js';
import type { CandidatePair } from './doc-conflict-pairing.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'doc-conflict-llm-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// collectInternalDocFragments
// ---------------------------------------------------------------------------

describe('Story 55.10 — collectInternalDocFragments', () => {
  it('returns sorted .md fragments with relative paths', () => {
    mkdirSync(join(tmp, '01-overview'), { recursive: true });
    mkdirSync(join(tmp, '05-modules'), { recursive: true });
    writeFileSync(join(tmp, '01-overview', 'index.md'), '# Overview');
    writeFileSync(join(tmp, '05-modules', 'core.md'), '# Core');
    writeFileSync(join(tmp, 'README.md'), 'root');

    const out = collectInternalDocFragments(tmp);
    expect(out.map(o => o.relPath).sort()).toEqual([
      '01-overview/index.md',
      '05-modules/core.md',
      'README.md',
    ]);
  });

  it('skips non-markdown files and dot-files', () => {
    writeFileSync(join(tmp, 'note.md'), '# md');
    writeFileSync(join(tmp, 'note.txt'), 'not md');
    writeFileSync(join(tmp, '.hidden.md'), 'hidden');
    writeFileSync(join(tmp, 'doc-conflicts.yaml'), 'yaml');

    const out = collectInternalDocFragments(tmp);
    expect(out).toHaveLength(1);
    expect(out[0].relPath).toBe('note.md');
  });

  it('returns empty array when directory does not exist', () => {
    const out = collectInternalDocFragments(join(tmp, 'nonexistent'));
    expect(out).toEqual([]);
  });

  it('returns empty array when directory is empty', () => {
    const out = collectInternalDocFragments(tmp);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDetectionUserMessage
// ---------------------------------------------------------------------------

describe('Story 55.10 — buildDetectionUserMessage', () => {
  it('includes all three input blocks with explicit headers', () => {
    const msg = buildDetectionUserMessage({
      referenceDocs: [{ source: 'md', path: 'docs/api.md', content: 'foo accepts string' }],
      internalFragments: [{ relPath: '05-modules/core.md', content: 'foo accepts Buffer' }],
      codeSurface: '### src/core/foo.ts\n- function `foo` (L1–L5)',
    });
    expect(msg).toContain('## REFERENCE_DOCS');
    expect(msg).toContain('## INTERNAL_DOCS');
    expect(msg).toContain('## CODE_SURFACE');
    expect(msg).toContain('foo accepts string');
    expect(msg).toContain('foo accepts Buffer');
    expect(msg).toContain('function `foo`');
  });

  it('emits empty-state placeholders when inputs are empty', () => {
    const msg = buildDetectionUserMessage({
      referenceDocs: [],
      internalFragments: [],
      codeSurface: '_No exported symbols found in the scanned project._',
    });
    expect(msg).toContain('_No reference docs found._');
    expect(msg).toContain('_No internal docs found._');
  });

  it('includes known conflict descriptions section when provided', () => {
    const msg = buildDetectionUserMessage({
      referenceDocs: [],
      internalFragments: [],
      codeSurface: 'surface',
      knownConflictDescriptions: ['id=abc123', 'id=def456'],
    });
    expect(msg).toContain('## ALREADY_KNOWN_CONFLICTS');
    expect(msg).toContain('id=abc123');
    expect(msg).toContain('Do NOT re-emit');
  });

  it('omits known conflicts section when none provided', () => {
    const msg = buildDetectionUserMessage({
      referenceDocs: [],
      internalFragments: [],
      codeSurface: 'surface',
    });
    expect(msg).not.toContain('ALREADY_KNOWN_CONFLICTS');
  });

  it('always ends with an Output section describing the JSON schema', () => {
    const msg = buildDetectionUserMessage({
      referenceDocs: [],
      internalFragments: [],
      codeSurface: 's',
    });
    expect(msg).toContain('## Output');
    expect(msg).toContain('"conflicts"');
  });
});

// ---------------------------------------------------------------------------
// parseDetectionResponse
// ---------------------------------------------------------------------------

describe('Story 55.10 — parseDetectionResponse', () => {
  const validItem = {
    file: 'src/foo.ts',
    symbol: 'doThing',
    line_start: 10,
    line_end: 20,
    reference_path: 'docs/api.md',
    reference_text: 'doThing accepts a string.',
    code_summary: 'doThing accepts a Buffer.',
    divergence: 'String vs Buffer.',
  };

  it('parses a valid JSON response with one conflict', () => {
    const text = JSON.stringify({ conflicts: [validItem] });
    const parsed = parseDetectionResponse(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.conflicts).toHaveLength(1);
    expect(parsed!.conflicts[0].file).toBe('src/foo.ts');
  });

  it('parses an empty result', () => {
    const parsed = parseDetectionResponse('{"conflicts":[]}');
    expect(parsed).toEqual({ conflicts: [] });
  });

  it('strips ```json fences if the model added them', () => {
    const fenced = '```json\n' + JSON.stringify({ conflicts: [validItem] }) + '\n```';
    const parsed = parseDetectionResponse(fenced);
    expect(parsed).not.toBeNull();
    expect(parsed!.conflicts).toHaveLength(1);
  });

  it('strips bare ``` fences too', () => {
    const fenced = '```\n' + JSON.stringify({ conflicts: [] }) + '\n```';
    const parsed = parseDetectionResponse(fenced);
    expect(parsed).toEqual({ conflicts: [] });
  });

  it('returns null on invalid JSON', () => {
    expect(parseDetectionResponse('not json at all')).toBeNull();
    expect(parseDetectionResponse('{ broken')).toBeNull();
  });

  it('returns null when schema validation fails', () => {
    expect(parseDetectionResponse('{"conflicts":[{"missing_required":true}]}')).toBeNull();
    expect(parseDetectionResponse('{}')).toBeNull();
  });

  it('accepts items with only required fields (no symbol, no line range)', () => {
    const minimal = {
      file: 'src/bar.ts',
      reference_path: 'README.md',
      reference_text: 'bar does X',
      code_summary: 'bar does Y',
      divergence: 'mismatch',
    };
    const parsed = parseDetectionResponse(JSON.stringify({ conflicts: [minimal] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.conflicts[0].symbol).toBeUndefined();
    expect(parsed!.conflicts[0].line_start).toBeUndefined();
  });
});

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
// doc 16 PR 2 — segmentForDetection (smartChunkDoc reuse)
// ---------------------------------------------------------------------------

describe('doc 16 PR 2 — segmentForDetection', () => {
  it('splits a multi-section markdown doc into labelled H2 segments', () => {
    const md = [
      '# Slot Engine',
      '',
      '## Payout',
      '',
      'The engine returns the total coin payout for the spin outcome.',
      '',
      '## RTP',
      '',
      'The engine targets a theoretical Return-to-Player of 95%. Long-run player return approximates the bet-weighted house edge of 5%.',
    ].join('\n');

    const out = segmentForDetection('README.md', md);
    expect(out).toContain('#### Payout');
    expect(out).toContain('#### RTP');
    expect(out).toContain('house edge of 5%');
    // The two sections are isolated blocks, not one undifferentiated page.
    expect(out.indexOf('#### Payout')).toBeLessThan(out.indexOf('#### RTP'));
  });

  it('returns the raw content verbatim when the chunker yields nothing (no silent drop)', () => {
    const tiny = 'short';
    expect(segmentForDetection('x.md', tiny)).toBe(tiny);
  });
});

// ---------------------------------------------------------------------------
// doc 16 PR 2b — buildPairDetectionUserMessage
// ---------------------------------------------------------------------------

describe('doc 16 PR 2b — buildPairDetectionUserMessage', () => {
  const pair: CandidatePair = {
    ref: { filePath: 'README.md', heading: 'RTP', content: 'house edge of 5% against the player', embedText: 'x', neighbor: 'ref neighbour text' },
    internal: { filePath: '05-modules/engine.md', heading: 'RTP', content: 'multiplied by 1.05 in the player favour', embedText: 'y', neighbor: 'int neighbour text' },
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
