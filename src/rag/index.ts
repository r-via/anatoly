// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

export { FunctionCardSchema } from './types.js';
export type { FunctionCard, SimilarityResult, RagStats } from './types.js';
export { embed, embedCode, embedNlp, buildEmbedCode, buildEmbedNlp, setEmbeddingLogger, configureModels, getCodeModelId, getNlpModelId, getCodeDim, getNlpDim, EMBEDDING_DIM, EMBEDDING_MODEL } from './embeddings.js';
export { VectorStore, sanitizeId, sanitizeFilePath } from './vector-store.js';
export type { UpsertOptions } from './vector-store.js';
export { buildFunctionCards, buildFunctionId, extractSignature, extractFunctionBody, computeComplexity, extractCalledInternals, needsReindex, embedCards, applyNlpSummaries, loadRagCache, saveRagCache, loadNlpSummaryCache, saveNlpSummaryCache, computeBodyHash } from './indexer.js';
export type { RagCache, NlpSummaryCache, NlpSummaryCacheEntry } from './indexer.js';
export { generateNlpSummaries } from './nlp-summarizer.js';
export type { NlpSummary } from './nlp-summarizer.js';
export { detectHardware, detectSidecar, resolveEmbeddingModels, getSidecarUrl, getSidecarPort, SIDECAR_MODEL, SIDECAR_DEFAULT_PORT, MODEL_REGISTRY } from './hardware-detect.js';
export type { HardwareProfile, SidecarStatus, ModelInfo, ResolvedModels } from './hardware-detect.js';
export { indexProject, processFileForIndex, processFileForDualIndex, ragModeArtifacts } from './orchestrator.js';
export type { RagMode, RagIndexOptions, RagIndexResult, IndexedFileResult } from './orchestrator.js';
