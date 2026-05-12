// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runTsContent = readFileSync(resolve(__dirname, '../commands/run.ts'), 'utf-8');

// ---------------------------------------------------------------------------
// Story 55.2 — Move runDocUpdate to pre-review position
// ---------------------------------------------------------------------------

describe('Story 55.2 — pipeline task registration order', () => {
  it('AC: internal-docs task is registered before review in pipelineState', () => {
    // The addTask('internal-docs', ...) call should appear before addTask('review', ...)
    const internalDocsTaskIdx = runTsContent.indexOf("addTask('internal-docs'");
    const reviewTaskIdx = runTsContent.indexOf("addTask('review'");
    expect(internalDocsTaskIdx).toBeGreaterThan(-1);
    expect(reviewTaskIdx).toBeGreaterThan(-1);
    expect(internalDocsTaskIdx).toBeLessThan(reviewTaskIdx);
  });
});

describe('Story 55.2 — pre-review doc update phase positioning', () => {
  it('AC: runDocUpdate is called before runReviewPhase', () => {
    const docUpdateIdx = runTsContent.indexOf('await runDocUpdate(');
    const reviewPhaseIdx = runTsContent.indexOf('await runReviewPhase(');
    expect(docUpdateIdx).toBeGreaterThan(-1);
    expect(reviewPhaseIdx).toBeGreaterThan(-1);
    expect(docUpdateIdx).toBeLessThan(reviewPhaseIdx);
  });

  it('AC: no post-review runDocUpdate block remains', () => {
    // There should be exactly one call to runDocUpdate in the pipeline
    const matches = runTsContent.match(/await runDocUpdate\(/g);
    expect(matches).toHaveLength(1);
  });

  it('AC: lite digest build occurs before review phase', () => {
    // The buildInternalDocsDigest call for the update phase should be before review
    // Find the second buildInternalDocsDigest call (first is in bootstrap)
    const allDigestCalls = [...runTsContent.matchAll(/buildInternalDocsDigest\(/g)];
    expect(allDigestCalls.length).toBeGreaterThanOrEqual(2);
    const reviewPhaseIdx = runTsContent.indexOf('await runReviewPhase(');
    // The last digest call (update phase) should be before review
    const lastDigestCall = allDigestCalls[allDigestCalls.length - 1];
    expect(lastDigestCall.index).toBeLessThan(reviewPhaseIdx);
  });
});

describe('Story 55.2 — gate changed from filesReviewed to triage-based', () => {
  it('AC: pre-review doc update does NOT use filesReviewed > 0 as gate', () => {
    // The internal-docs update phase should NOT gate on filesReviewed.
    // Extract the if/else block after the phase comment (skip the comment lines).
    const phaseComment = '--- Phase: update internal docs';
    const phaseIdx = runTsContent.indexOf(phaseComment);
    expect(phaseIdx).toBeGreaterThan(-1);

    // Skip to the first `if (` after the comment — that's the actual gate code
    const codeStart = runTsContent.indexOf('if (', phaseIdx);
    const phaseBlock = runTsContent.slice(codeStart, codeStart + 600);
    expect(phaseBlock).not.toContain('filesReviewed > 0');
    expect(phaseBlock).not.toContain('filesReviewed>0');
  });

  it('AC: pre-review doc update uses triage-based gate (hasEvaluableFiles)', () => {
    const phaseComment = '--- Phase: update internal docs';
    const phaseIdx = runTsContent.indexOf(phaseComment);
    const phaseBlock = runTsContent.slice(phaseIdx, phaseIdx + 800);
    // Should check triageMap or equivalent for evaluable files
    expect(phaseBlock).toContain('hasEvaluableFiles');
  });
});

describe('Story 55.2 — writeScaffoldStatus preserved', () => {
  it('AC: writeScaffoldStatus with mode update still called after doc update', () => {
    const docUpdateIdx = runTsContent.indexOf('await runDocUpdate(');
    const scaffoldAfter = runTsContent.indexOf("mode: 'update'", docUpdateIdx);
    expect(scaffoldAfter).toBeGreaterThan(docUpdateIdx);
  });
});

describe('Story 55.2 — RAG reindex after doc update preserved', () => {
  it('AC: reindexDocsAfterUpdate still called after runDocUpdate', () => {
    const docUpdateIdx = runTsContent.indexOf('await runDocUpdate(');
    const reindexAfter = runTsContent.indexOf('reindexDocsAfterUpdate', docUpdateIdx);
    expect(reindexAfter).toBeGreaterThan(docUpdateIdx);
  });
});
