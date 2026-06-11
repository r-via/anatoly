// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * `scanning/` bounded context: the Scan / Usage-Graph phases. Static project
 * analysis, zero LLM cost. A pure sink: no cross-context out-edges, so its
 * barrel carries no transitional back-edge (no barrel-cycle risk, doc 12 §5).
 *
 * Published surface (doc 12 §1 rule 1, doc 13 PR 5). Everything outside this
 * context imports this barrel, never a module path inside it. The surface is
 * exactly the symbols current external importers use, no speculative API
 * (doc 13 §8).
 */

export { scanProject, parseFile, parseToRootNode, collectUsageImporterFiles, scanUsageImporters } from './scanner.js';

export { autoDetectScanGlobs } from './scan-autodetect.js';

export {
  detectProjectProfile,
  formatLanguageLine,
  formatFrameworkLine,
} from './language-detect.js';
export type { ProjectProfile, ProjectType } from './language-detect.js';

export { resolveAdapter } from './language-adapters.js';

export {
  buildUsageGraph,
  getSymbolUsage,
  getTypeOnlySymbolUsage,
  getTransitiveUsage,
  getImportedSymbolsBySource,
  getTransitiveImporters,
  resolveExportedSymbolUtility,
  resolveNonExportedSymbolUtility,
} from './usage-graph.js';
export type { UsageGraph } from './usage-graph.js';

export {
  loadDependencyMeta,
  extractFileDeps,
  extractRelevantReadmeSections,
} from './dependency-meta.js';
export type { DependencyMeta, FileDependencyContext } from './dependency-meta.js';

export { resolveModuleGranularity, extractModuleName } from './module-granularity.js';
export type { ModuleDir } from './module-granularity.js';

export { buildPageContext } from './source-context.js';
export type { PageContext, SymbolContext, SourceFile } from './source-context.js';

export { buildProjectTree } from './project-tree.js';

export { detectProjectIdentity } from './project-version.js';
