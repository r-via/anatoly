// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Task } from '../../../schemas/task.js';

/**
 * A wiring edge the static import graph missed: `symbol` exported from
 * `sourceFile` is actually consumed by `importer` through a framework mechanism
 * (JSX rendering, a router, dependency injection, a decorator, a registry…)
 * that a plain import/call scan cannot see. Fed into the usage graph exactly
 * like a real import edge, so every downstream consumer (flow, utility/dead,
 * overengineering) sees the symbol as wired.
 */
export interface WiringEdge {
  symbol: string;
  sourceFile: string;
  importer: string;
}

/**
 * Everything a recognizer needs to find the edges its framework adds, without
 * depending on usage-graph internals. `resolveImport` is the same path resolver
 * the usage graph uses (passed as a closure so module-private logic — path
 * aliases, extension probing, index files — stays in one place); it returns a
 * project-relative file path keyed the same way as `exportsByFile`.
 */
export interface WiringContext {
  projectRoot: string;
  /** Audit tasks plus importer-only tasks — every file that can wire a symbol. */
  importers: Task[];
  /** file → declared exported symbol names (the keys the consumers look up). */
  exportsByFile: Map<string, Set<string>>;
  /** Resolve an import specifier from `importerAbs` to a project-relative file. */
  resolveImport: (specifier: string, importerAbs: string) => string | undefined;
  /** Discovered frameworks (lowercased ids), the trigger for `appliesTo`. */
  frameworks: ReadonlySet<string>;
}

/**
 * A language/framework-specific recognizer of wiring the static graph misses.
 * Recognizers are activated by discovery (`appliesTo`, keyed on the detected
 * frameworks/extensions), so adding support for a new ecosystem (Spring
 * `@GetMapping`, Django `urls.py`, Go `mux.HandleFunc`, NestJS decorators…) is
 * a new recognizer in the registry below — the core never changes.
 */
export interface WiringRecognizer {
  readonly id: string;
  appliesTo(ctx: WiringContext): boolean;
  recognize(ctx: WiringContext): WiringEdge[];
}

// Registry. Import recognizers here; order is irrelevant (edges are merged into
// a Set downstream, so duplicates are harmless).
import { reactWiringRecognizer } from './react-wiring.js';

export const WIRING_RECOGNIZERS: readonly WiringRecognizer[] = [
  reactWiringRecognizer,
];

/**
 * Run every applicable recognizer and collect the wiring edges they find.
 * A recognizer that does not apply (its framework was not discovered) is
 * skipped, so a non-React, non-decorator codebase pays nothing.
 */
export function recognizeWiringEdges(ctx: WiringContext): WiringEdge[] {
  const edges: WiringEdge[] = [];
  for (const recognizer of WIRING_RECOGNIZERS) {
    if (!recognizer.appliesTo(ctx)) continue;
    edges.push(...recognizer.recognize(ctx));
  }
  return edges;
}
