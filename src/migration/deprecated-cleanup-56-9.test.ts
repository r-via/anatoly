// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');

// ---------------------------------------------------------------------------
// Story 56.9 — FR21: verboseLog removed
// ---------------------------------------------------------------------------
describe('FR21: verboseLog removed from format.ts', () => {
  it('format.ts does not export verboseLog', () => {
    const src = read('src/utils/format.ts');
    expect(src).not.toContain('export function verboseLog');
  });
});

// ---------------------------------------------------------------------------
// Story 56.9 — FR22: correction-memory legacy exports removed
// ---------------------------------------------------------------------------
describe('FR22: correction-memory legacy exports removed', () => {
  it('FalsePositiveEntry type alias is absent', () => {
    const src = read('src/core/platform/correction-memory.ts');
    expect(src).not.toContain('FalsePositiveEntry');
  });

  it('CorrectionMemory type alias is absent', () => {
    const src = read('src/core/platform/correction-memory.ts');
    expect(src).not.toContain('CorrectionMemory');
  });

  it('loadCorrectionMemory alias is absent', () => {
    const src = read('src/core/platform/correction-memory.ts');
    expect(src).not.toContain('loadCorrectionMemory');
  });

  it('saveCorrectionMemory alias is absent', () => {
    const src = read('src/core/platform/correction-memory.ts');
    expect(src).not.toContain('saveCorrectionMemory');
  });
});

// ---------------------------------------------------------------------------
// Story 56.9 — FR23: EmbeddingsReadyFlag.python removed
// ---------------------------------------------------------------------------
describe('FR23: EmbeddingsReadyFlag.python removed', () => {
  it('hardware-detect.ts EmbeddingsReadyFlag has no python field', () => {
    const src = read('src/rag/hardware-detect.ts');
    // Match the specific interface field, not general python mentions
    const iface = src.slice(src.indexOf('interface EmbeddingsReadyFlag'), src.indexOf('}', src.indexOf('interface EmbeddingsReadyFlag')));
    expect(iface).not.toContain('python');
  });
});

// ---------------------------------------------------------------------------
// Story 56.9 — FR24: renderShard removed from reporter.ts
// ---------------------------------------------------------------------------
describe('FR24: renderShard removed from reporter.ts', () => {
  it('reporter.ts does not export renderShard', () => {
    const src = read('src/core/reporting/reporter.ts');
    expect(src).not.toContain('export function renderShard');
  });
});

// ---------------------------------------------------------------------------
// Story 56.9 — FR25: DocPrompt alias removed
// ---------------------------------------------------------------------------
describe('FR25: DocPrompt alias removed from doc-llm-executor.ts', () => {
  it('doc-llm-executor.ts does not export DocPrompt', () => {
    const src = read('src/core/documentation/generation/doc-llm-executor.ts');
    expect(src).not.toContain('export type DocPrompt');
  });
});

// ---------------------------------------------------------------------------
// Story 56.9 — FR26: resolveNlpModel alias removed
// ---------------------------------------------------------------------------
describe('FR26: resolveNlpModel alias removed from axis-evaluator.ts', () => {
  it('axis-evaluator.ts does not export resolveNlpModel', () => {
    const src = read('src/core/axis-evaluator.ts');
    expect(src).not.toContain('export function resolveNlpModel');
  });
});

// ---------------------------------------------------------------------------
// Story 56.9 — FR27: detectDocGaps + formatGapSummary v1 removed
// ---------------------------------------------------------------------------
describe('FR27: doc-gap-detection v1 functions removed', () => {
  it('detectDocGaps v1 function is absent', () => {
    const src = read('src/core/documentation/reporting/doc-gap-detection.ts');
    expect(src).not.toContain('export async function detectDocGaps(');
  });

  it('formatGapSummary v1 function is absent', () => {
    const src = read('src/core/documentation/reporting/doc-gap-detection.ts');
    expect(src).not.toContain('export function formatGapSummary(');
  });

  it('GapClassification legacy type is absent', () => {
    const src = read('src/core/documentation/reporting/doc-gap-detection.ts');
    expect(src).not.toContain('export type GapClassification');
  });

  it('GapDetectionResult legacy interface is absent', () => {
    const src = read('src/core/documentation/reporting/doc-gap-detection.ts');
    expect(src).not.toContain('export interface GapDetectionResult');
  });
});

// ---------------------------------------------------------------------------
// Story 56.9 — FR28: NLP cache migration one-shot removed
// ---------------------------------------------------------------------------
describe('FR28: NLP cache migration one-shot removed from indexer.ts', () => {
  it('migrateLegacyNlpCaches function is absent', () => {
    const src = read('src/rag/indexer.ts');
    expect(src).not.toContain('migrateLegacyNlpCaches');
  });
});
