// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Unit tests for the unified doc-source indexing decision tree
 * (`indexDocSources`). The leaf calls live in `./doc-indexer.js`, which is a
 * real module boundary here and is mocked — so we exercise the
 * docsIdentical / alias / referencePaths branching in isolation, exactly the
 * logic that used to be duplicated between the full rag-index pass and the
 * post-update incremental reindex.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VectorStore } from './vector-store.js';

const indexDocSectionsMock = vi.fn();
const areDocTreesIdenticalMock = vi.fn();
const resolveReferenceDocFilesMock = vi.fn();

vi.mock('./doc-indexer.js', () => ({
  indexDocSections: (...a: unknown[]) => indexDocSectionsMock(...a),
  areDocTreesIdentical: (...a: unknown[]) => areDocTreesIdenticalMock(...a),
  resolveReferenceDocFiles: (...a: unknown[]) => resolveReferenceDocFilesMock(...a),
}));

const { indexDocSources } = await import('./doc-sources.js');

function makeStore() {
  return {
    aliasDocSource: vi.fn().mockResolvedValue(7),
  } as unknown as VectorStore & { aliasDocSource: ReturnType<typeof vi.fn> };
}

function baseOpts(store: VectorStore) {
  return {
    projectRoot: '/proj',
    vectorStore: store,
    docsDir: 'docs',
    internalDocsDir: '.anatoly/state/internal-docs',
    cacheSuffix: 'advanced',
    onLog: vi.fn(),
  };
}

beforeEach(() => {
  indexDocSectionsMock.mockReset().mockResolvedValue({ sections: 3, cached: false, costUsd: 0.01 });
  areDocTreesIdenticalMock.mockReset().mockReturnValue(false);
  resolveReferenceDocFilesMock.mockReset().mockReturnValue([]);
});

describe('indexDocSources', () => {
  it('trees differ → indexes project + internal, no alias', async () => {
    const store = makeStore();
    const r = await indexDocSources(baseOpts(store));

    expect(indexDocSectionsMock).toHaveBeenCalledTimes(2);
    expect(store.aliasDocSource).not.toHaveBeenCalled();
    expect(r.docsIdentical).toBe(false);
    expect(r.projectDocSections).toBe(3);
    expect(r.internalDocSections).toBe(3);
    expect(r.docSectionsIndexed).toBe(6);
    expect(r.costUsd).toBeCloseTo(0.02);
  });

  it('trees identical → indexes internal only, aliases project (dedup parity)', async () => {
    areDocTreesIdenticalMock.mockReturnValue(true);
    const store = makeStore();
    const r = await indexDocSources(baseOpts(store));

    expect(indexDocSectionsMock).toHaveBeenCalledTimes(1);
    expect(store.aliasDocSource).toHaveBeenCalledWith('internal', 'project', '.anatoly/state/internal-docs', 'docs');
    expect(r.docsIdentical).toBe(true);
    expect(r.internalDocSections).toBe(3);
    expect(r.projectDocSections).toBe(7); // alias return value, not double-counted
    expect(r.docSectionsIndexed).toBe(3);
  });

  it('pre-computed docsIdentical is honored without re-detecting', async () => {
    const store = makeStore();
    await indexDocSources({ ...baseOpts(store), docsIdentical: true });

    expect(areDocTreesIdenticalMock).not.toHaveBeenCalled();
    expect(store.aliasDocSource).toHaveBeenCalledTimes(1);
  });

  it('explicit referencePaths forces per-file project indexing and disables alias', async () => {
    areDocTreesIdenticalMock.mockReturnValue(true); // would alias if not overridden
    resolveReferenceDocFilesMock.mockReturnValue(['/proj/README.md']);
    const store = makeStore();
    const r = await indexDocSources({ ...baseOpts(store), referencePaths: ['README.md'], docsIdentical: true });

    expect(areDocTreesIdenticalMock).not.toHaveBeenCalled();
    expect(store.aliasDocSource).not.toHaveBeenCalled();
    expect(indexDocSectionsMock).toHaveBeenCalledTimes(2);
    const projCall = indexDocSectionsMock.mock.calls[0][0] as { files?: string[] };
    expect(projCall.files).toEqual(['/proj/README.md']);
    expect(r.docsIdentical).toBe(false);
  });

  it('identity-check throw → falls back to double indexing (logged)', async () => {
    areDocTreesIdenticalMock.mockImplementation(() => { throw new Error('permission denied'); });
    const store = makeStore();
    const opts = baseOpts(store);
    const r = await indexDocSources(opts);

    expect(opts.onLog).toHaveBeenCalledWith(expect.stringContaining('doc identity check failed'));
    expect(indexDocSectionsMock).toHaveBeenCalledTimes(2);
    expect(r.docsIdentical).toBe(false);
  });

  it('a failing source is swallowed, the other still indexes', async () => {
    indexDocSectionsMock
      .mockRejectedValueOnce(new Error('project boom'))
      .mockResolvedValueOnce({ sections: 5, cached: false, costUsd: 0.03 });
    const store = makeStore();
    const opts = baseOpts(store);
    const r = await indexDocSources(opts);

    expect(opts.onLog).toHaveBeenCalledWith(expect.stringContaining('doc section indexing failed'));
    expect(r.projectDocSections).toBe(0);
    expect(r.internalDocSections).toBe(5);
  });
});
