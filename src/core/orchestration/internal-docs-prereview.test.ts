// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// PR 8a (doc 11) extracted the orchestration spine out of run.ts into
// pipeline.ts byte-verbatim. Every assertion here checks spine structure
// (phase ordering, gates, task registration), so it reads the pipeline
// module now. Behavior is unchanged and additionally guarded by the
// spine golden.
const runTsContent = readFileSync(resolve(__dirname, 'pipeline.ts'), 'utf-8');

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

  // The original AC required `buildInternalDocsDigest` to run before the
  // review phase. The digest itself has been removed: lite mode now feeds
  // reference content to the axes per file via RAG retrieval (see
  // `retrieveRelevantDocsForFile`), so there is nothing to schedule at the
  // run scope. The runDocUpdate ordering (covered above) is still enforced
  // for `mode: full` runs.
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

// ---------------------------------------------------------------------------
// resume-in-place — doc-update short-circuit
//
// A run that completed the doc-update phase group then crashed in a LATER
// phase (e.g. deliberation) must NOT replay the expensive LLM doc
// regeneration / RAG re-index / conflict detection when resumed. The signal
// is the scaffold marker: `--resume` reuses the same runId, so a marker with
// `lastMode === 'update'` AND `lastRunId === ctx.runId` proves this run already
// finished doc-update in a prior attempt.
// ---------------------------------------------------------------------------

describe('resume-in-place — doc-update short-circuit', () => {
  it('keys the skip on the scaffold marker matching THIS run (lastRunId === ctx.runId, mode update)', () => {
    expect(runTsContent).toContain('docUpdateAlreadyDone');
    expect(runTsContent).toContain("resumedDocStatus?.lastMode === 'update'");
    expect(runTsContent).toContain('resumedDocStatus.lastRunId === ctx.runId');
  });

  it('short-circuits BEFORE runDocUpdate (skips, never replays the body)', () => {
    const skipBranchIdx = runTsContent.indexOf("'skipped (resumed — already updated)'");
    const docUpdateIdx = runTsContent.indexOf('await runDocUpdate(');
    expect(skipBranchIdx).toBeGreaterThan(-1);
    expect(docUpdateIdx).toBeGreaterThan(-1);
    expect(skipBranchIdx).toBeLessThan(docUpdateIdx);
  });

  it('only fires when the gate would otherwise run the phase (id.run guard)', () => {
    // The skip branch must be gated on id.run so off/lite/no-evaluable runs
    // keep their existing skip-reason branches instead of this one.
    expect(runTsContent).toContain('if (id.run && docUpdateAlreadyDone && !ctx.interrupted)');
  });

  it('completes all three doc-update tasks so the TUI does not hang on resume', () => {
    const skipBranchIdx = runTsContent.indexOf('if (id.run && docUpdateAlreadyDone');
    const branch = runTsContent.slice(skipBranchIdx, skipBranchIdx + 500);
    expect(branch).toContain("completeTask('internal-docs', 'skipped (resumed — already updated)')");
    expect(branch).toContain("completeTask('rag-index-update', 'skipped (resumed)')");
    expect(branch).toContain("completeTask('doc-conflict-update', 'skipped (resumed)')");
  });
});
