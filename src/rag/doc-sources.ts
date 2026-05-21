// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

// ---------------------------------------------------------------------------
// Unified doc-source indexing — single source of truth for the
// "index project + internal docs, honoring docsIdentical/alias" decision
// tree. Previously written twice (orchestrator.ts full pass +
// reindexDocsAfterUpdate incremental pass); the two had drifted (the
// incremental pass skipped project entirely on dedup and never re-aliased).
// Both callers now go through here, so dedup-mode projects get a correct
// internal→project alias after every docs update.
//
// Lives in its own module (not doc-indexer.ts) so the leaf calls
// (indexDocSections / areDocTreesIdentical / resolveReferenceDocFiles) are a
// real module boundary that callers' tests can mock.
// ---------------------------------------------------------------------------

import type { TransportRouter } from '../core/transports/index.js';
import type { VectorStore } from './vector-store.js';
import { indexDocSections, areDocTreesIdentical, resolveReferenceDocFiles } from './doc-indexer.js';

/** Inputs for {@link indexDocSources}. */
export interface IndexDocSourcesOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Vector store to upsert/alias doc section embeddings into. */
  vectorStore: VectorStore;
  /** Project docs directory relative to projectRoot (e.g. `'docs'`). */
  docsDir: string;
  /** Internal docs directory relative to projectRoot (e.g. `.anatoly/state/internal-docs`). */
  internalDocsDir: string;
  /** Base cache suffix; internal docs use `${cacheSuffix}-internal`. */
  cacheSuffix: string;
  /** Model for semantic chunking. */
  chunkModel?: string;
  /**
   * `documentation.reference.paths` globs. When non-empty, project docs are
   * indexed per-file from these paths AND the docs-identity alias is disabled
   * (root-level files like README.md may fall outside `docsDir`).
   */
  referencePaths?: string[];
  /**
   * Pre-computed docs-identity verdict. When provided, identity detection is
   * skipped and this value is used (callers that already know it from a prior
   * rag-index pass pass it to avoid recomputation). When omitted, identity is
   * detected here (unless `referencePaths` forces per-file indexing).
   */
  docsIdentical?: boolean;
  onLog: (message: string) => void;
  onProgress?: (current: number, total: number) => void;
  onFileStart?: (file: string) => void;
  onFileDone?: (file: string) => void;
  /** UI hook: emitted as each doc sub-phase begins, so task transitions work. */
  onPhase?: (phase: 'doc-project' | 'doc-internal') => void;
  isInterrupted?: () => boolean;
  conversationDir?: string;
  router?: TransportRouter;
  concurrency?: number;
}

/** Accounting returned by {@link indexDocSources}. */
export interface IndexDocSourcesResult {
  /** project + internal sections newly indexed (alias content not double-counted). */
  docSectionsIndexed: number;
  projectDocSections: number;
  projectDocsCached: boolean;
  internalDocSections: number;
  internalDocsCached: boolean;
  /** Effective docs-identity verdict used for this pass. */
  docsIdentical: boolean;
  /** Total LLM cost (USD) for doc chunking across both sources. */
  costUsd: number;
}

/**
 * Index project docs and internal docs into the vector store, applying the
 * docs-identity optimization: when `docs/` and the internal docs tree are
 * byte-identical, only internal docs are chunked/embedded and the project
 * source is produced by aliasing internal → project (no double-chunk). When
 * they differ (or explicit `reference.paths` are configured), both sources
 * are indexed independently.
 *
 * Failures of either source are swallowed and logged via `onLog` (one bad
 * source must not abort the run) — identical to the pre-unification behavior.
 */
export async function indexDocSources(
  options: IndexDocSourcesOptions,
): Promise<IndexDocSourcesResult> {
  const {
    projectRoot,
    vectorStore: store,
    docsDir,
    internalDocsDir,
    cacheSuffix,
    chunkModel,
    referencePaths,
    onLog,
    onProgress,
    onFileStart,
    onFileDone,
    onPhase,
    isInterrupted,
    conversationDir,
    router,
    concurrency,
  } = options;

  let docSectionsIndexed = 0;
  let projectDocSections = 0;
  let projectDocsCached = false;
  let internalDocSections = 0;
  let internalDocsCached = false;
  let costUsd = 0;

  // Check if docs/ and the internal tree are byte-identical to avoid
  // double-chunking. The alias optimization only handles a single source
  // directory, so when the user declares explicit `reference.paths` (which
  // may include root-level files outside docsDir), we always go through the
  // per-file indexing path to avoid dropping content.
  const hasExplicitReferencePaths = (referencePaths?.length ?? 0) > 0;
  let docsIdentical = false;
  if (!hasExplicitReferencePaths) {
    if (options.docsIdentical !== undefined) {
      docsIdentical = options.docsIdentical;
    } else {
      try {
        docsIdentical = areDocTreesIdentical(projectRoot, docsDir, internalDocsDir);
      } catch (err) {
        onLog(`doc identity check failed, falling back to double indexing: ${(err as Error).message}`);
      }
    }
  }

  const sharedOpts = {
    projectRoot,
    vectorStore: store,
    chunkModel,
    onLog,
    onProgress,
    onFileStart,
    onFileDone,
    isInterrupted,
    conversationDir,
    router,
    concurrency,
  };

  if (docsIdentical) {
    // Trees are identical — index only internal, then alias as project.
    onLog('docs/ identical to internal docs — indexing internal only, aliasing project');

    onPhase?.('doc-project'); // emit both phases so UI task transitions work
    onPhase?.('doc-internal');
    try {
      const intResult = await indexDocSections({
        ...sharedOpts,
        docsDir: internalDocsDir,
        cacheSuffix: `${cacheSuffix}-internal`,
        docSource: 'internal',
      });
      internalDocSections = intResult.sections;
      internalDocsCached = intResult.cached;
      costUsd += intResult.costUsd;
      docSectionsIndexed += internalDocSections;

      // Alias internal → project (don't add to docSectionsIndexed — same content).
      const aliased = await store.aliasDocSource('internal', 'project', internalDocsDir, docsDir);
      projectDocSections = aliased;
      projectDocsCached = intResult.cached;
    } catch (err) {
      onLog(`internal doc section indexing failed: ${(err as Error).message}`);
    }
  } else {
    // Trees differ (or explicit reference.paths) — index both independently.
    onPhase?.('doc-project');
    const referenceFiles = referencePaths && referencePaths.length > 0
      ? resolveReferenceDocFiles(projectRoot, referencePaths)
      : undefined;
    try {
      const projResult = await indexDocSections({
        ...sharedOpts,
        ...(referenceFiles && referenceFiles.length > 0 ? { files: referenceFiles } : {}),
        docsDir,
        cacheSuffix,
        docSource: 'project',
      });
      projectDocSections = projResult.sections;
      projectDocsCached = projResult.cached;
      costUsd += projResult.costUsd;
      docSectionsIndexed += projectDocSections;
    } catch (err) {
      onLog(`doc section indexing failed: ${(err as Error).message}`);
    }

    onPhase?.('doc-internal');
    try {
      const intResult = await indexDocSections({
        ...sharedOpts,
        docsDir: internalDocsDir,
        cacheSuffix: `${cacheSuffix}-internal`,
        docSource: 'internal',
      });
      internalDocSections = intResult.sections;
      internalDocsCached = intResult.cached;
      costUsd += intResult.costUsd;
      docSectionsIndexed += internalDocSections;
    } catch (err) {
      onLog(`internal doc section indexing failed: ${(err as Error).message}`);
    }
  }

  return {
    docSectionsIndexed,
    projectDocSections,
    projectDocsCached,
    internalDocSections,
    internalDocsCached,
    docsIdentical,
    costUsd,
  };
}
