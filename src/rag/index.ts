// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

export { FunctionCardSchema } from './types.js';
export type { FunctionCard, SimilarityResult, RagStats, DocSectionEntry } from './types.js';
export { embed, embedCode, embedNlp, embedCodeBatch, embedNlpBatch, buildEmbedCode, buildEmbedNlp, setEmbeddingLogger, configureModels, getCodeModelId, getNlpModelId, getCodeDim, getNlpDim, EMBEDDING_DIM, EMBEDDING_MODEL } from './embeddings.js';
export { VectorStore, sanitizeId, sanitizeFilePath } from './vector-store.js';
export type { UpsertOptions } from './vector-store.js';
export { buildFunctionCards, buildFunctionId, extractSignature, extractFunctionBody, computeComplexity, extractCalledInternals, needsReindex, embedCards, applyNlpSummaries, enrichCardsWithSummaries, generateNlpEmbeddings, loadRagCache, saveRagCache, loadNlpSummaryCache, saveNlpSummaryCache, computeBodyHash } from './indexer.js';
export type { RagCache, NlpSummaryCache, NlpSummaryCacheEntry } from './indexer.js';
export { generateNlpSummaries } from './nlp-summarizer.js';
export type { NlpSummary } from './nlp-summarizer.js';
export { detectHardware, resolveEmbeddingModels, readEmbeddingsReadyFlag, determineBackend, CODE_MODEL_ID, NLP_MODEL_ID, MODEL_REGISTRY, GGUF_DOCKER_IMAGE, GGUF_CODE_PORT, GGUF_NLP_PORT, GGUF_CODE_MODEL_FILE, GGUF_NLP_MODEL_FILE, GGUF_MIN_VRAM_GB } from './hardware-detect.js';
export type { HardwareProfile, ModelInfo, ResolvedModels, EmbeddingBackend, EmbeddingsReadyFlag } from './hardware-detect.js';
export { startTeiContainers, stopTeiContainers, areTeiContainersRunning, TEI_DOCKER_IMAGE, TEI_CODE_PORT, TEI_NLP_PORT } from './docker-tei.js';
export { indexProject, processFileForDualIndex, ragModeArtifacts } from './orchestrator.js';
export type { RagMode, RagIndexOptions, RagIndexResult, IndexedFileResult } from './orchestrator.js';
export { parseDocSections, collectDocSections, indexDocSections, buildDocSectionId, stripCodeBlocks } from './doc-indexer.js';
export type { DocSection, DocIndexOptions, DocIndexResult } from './doc-indexer.js';
export { startGgufContainers, stopGgufContainers, areGgufContainersRunning } from './docker-gguf.js';
