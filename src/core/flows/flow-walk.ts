// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Deterministic user-flow skeleton walk (doc 23, section 3.1 / Stage 1).
 *
 * Pure graph code, NO LLM: given the RAG function cards and the import/usage
 * graph already in memory after the RAG phase, derive the `UserFlow`
 * skeletons. The same index plus the same source always produce the same
 * skeletons (doc 23 invariant I2), so this is hermetically testable without
 * any model call.
 *
 * Shape of the walk:
 *  - enumerate ENTRY candidates: a reference-graph ROOT (no real internal
 *    consumer, seeing THROUGH public re-export barrels, so an external actor
 *    enters here) whose `behavioralProfile` marks a request/command boundary
 *    (`sideEffectful` or `async`) AND that has at least one resolvable out-edge
 *    (doc 23, section 2 entry signal; strict graph+profile predicate,
 *    per-language route/CLI conventions deferred).
 *  - for each entry, walk the forward edges (`referencedImports` cross-file,
 *    `calledInternals` same-file) depth-first to a bounded depth, collecting
 *    steps and terminal effects; stop at leaves, the depth cap, or the
 *    per-flow step cap (FP + cost bound, mirrors the invariants caps).
 *  - mark `unwired` when an entry resolves but its path reaches no effect (a
 *    candidate dead-intent flow, doc 23 section 5).
 *
 * Every output field is derived strictly from what the graph proves; nothing
 * is invented (doc 23 invariant I3). Emits zero scored findings (I1).
 */

import {
  getImportedSymbolsBySource,
  getRealConsumers,
  type UsageGraph,
} from '../scanning/usage-graph.js';
import type { FunctionCard } from '../../rag/types.js';
import type { UserFlow, FlowStep, FlowEffect } from '../../schemas/user-flow.js';

// ---------------------------------------------------------------------------
// Caps — conservative + explicit (doc 23 invariant I5, mirrors invariants.ts).
// ---------------------------------------------------------------------------

export interface FlowWalkCaps {
  /** Max entry candidates considered (sorted, then truncated). */
  maxEntries: number;
  /** Max hop depth from the entry before the walk stops (truncation lowers confidence). */
  maxDepth: number;
  /** Max steps collected per flow before the walk stops. */
  maxStepsPerFlow: number;
  /** Max flows emitted in the artifact (final cap, sorted by id then truncated). */
  maxFlows: number;
}

export const DEFAULT_FLOW_WALK_CAPS: FlowWalkCaps = {
  maxEntries: 200,
  maxDepth: 6,
  maxStepsPerFlow: 40,
  maxFlows: 100,
};

export interface BuildFlowSkeletonsInput {
  cards: FunctionCard[];
  usageGraph: UsageGraph;
  caps?: Partial<FlowWalkCaps>;
}

// ---------------------------------------------------------------------------
// Profile → honest Stage-1 classifiers.
// ---------------------------------------------------------------------------

/** A card whose profile marks it a terminal side effect (a path leaf). */
function isEffectCard(card: FunctionCard): boolean {
  return card.behavioralProfile === 'sideEffectful' || card.behavioralProfile === 'stateful';
}

function effectKind(card: FunctionCard): FlowEffect['kind'] {
  return card.behavioralProfile === 'stateful' ? 'state_mutation' : 'side_effect';
}

function stepRole(card: FunctionCard): FlowStep['role'] {
  switch (card.behavioralProfile) {
    case 'sideEffectful':
      return 'effect';
    case 'stateful':
      return 'state';
    case 'async':
      return 'async';
    case 'pure':
    case 'memoized':
    case 'utility':
      return 'transform';
    default:
      return 'unknown';
  }
}

/** Stable map key for a card, matching the usage-graph `symbol::file` convention. */
function cardKey(name: string, filePath: string): string {
  return `${name}::${filePath}`;
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/**
 * Build the deterministic flow skeletons from the in-memory RAG cards and the
 * usage graph. Pure (no I/O, no LLM, no randomness).
 */
export function buildFlowSkeletons(input: BuildFlowSkeletonsInput): UserFlow[] {
  const caps: FlowWalkCaps = { ...DEFAULT_FLOW_WALK_CAPS, ...input.caps };
  const { cards, usageGraph } = input;

  // Symbol lookup keyed exactly like the usage graph (`name::file`). Both cards
  // and the graph use the same project-relative file paths (task.file).
  const byKey = new Map<string, FunctionCard>();
  for (const card of cards) {
    byKey.set(cardKey(card.name, card.filePath), card);
  }

  // Per-file forward import resolution: file → (imported name → source files),
  // computed lazily and cached. Inverts getImportedSymbolsBySource so a
  // cross-file referencedImport name can be resolved to the project file that
  // exports it. A name with >1 source is ambiguous (lowers confidence; the
  // sorted-first source is chosen deterministically).
  const importSourcesCache = new Map<string, Map<string, string[]>>();
  function importSourcesFor(file: string): Map<string, string[]> {
    const cached = importSourcesCache.get(file);
    if (cached) return cached;
    const bySource = getImportedSymbolsBySource(usageGraph, file);
    const out = new Map<string, string[]>();
    for (const [src, names] of bySource) {
      for (const n of names) {
        let list = out.get(n);
        if (!list) {
          list = [];
          out.set(n, list);
        }
        list.push(src);
      }
    }
    for (const list of out.values()) list.sort();
    importSourcesCache.set(file, out);
    return out;
  }

  // Resolve a card's forward edges to concrete child cards, deterministically
  // ordered by (file, symbol). Sets `ambiguous` when a cross-file name resolves
  // to more than one source file.
  function resolveChildren(card: FunctionCard, flags: { ambiguous: boolean }): FunctionCard[] {
    const out: FunctionCard[] = [];
    const seen = new Set<string>();

    // Same-file edges: calledInternals are names defined in the same file.
    for (const name of card.calledInternals) {
      const key = cardKey(name, card.filePath);
      const child = byKey.get(key);
      if (child && !seen.has(child.id)) {
        seen.add(child.id);
        out.push(child);
      }
    }

    // Cross-file edges: referencedImports are other-file names; the usage graph
    // resolves which project file each is imported from.
    const sourcesByName = importSourcesFor(card.filePath);
    for (const name of card.referencedImports) {
      const sources = sourcesByName.get(name);
      if (!sources || sources.length === 0) continue; // external / unresolved → skip
      if (sources.length > 1) flags.ambiguous = true;
      const child = byKey.get(cardKey(name, sources[0]!));
      if (child && !seen.has(child.id)) {
        seen.add(child.id);
        out.push(child);
      }
    }

    out.sort((a, b) => {
      const ka = `${a.filePath}::${a.name}`;
      const kb = `${b.filePath}::${b.name}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return out;
  }

  // ENTRY enumeration: reference-graph roots with a boundary profile and at
  // least one resolvable out-edge. Sorted for determinism, then capped. The
  // root check sees through public re-export barrels (a symbol exposed only via
  // `export { x } from` at the package surface still roots), so the canonical
  // `index.ts` barrel does not mask the real entry.
  const entryCandidates: FunctionCard[] = [];
  for (const card of cards) {
    const profile = card.behavioralProfile;
    if (profile !== 'sideEffectful' && profile !== 'async') continue;
    const consumers = getRealConsumers(usageGraph, card.name, card.filePath);
    if (consumers.length !== 0) continue; // an internal consumer → not an external entry
    entryCandidates.push(card);
  }
  entryCandidates.sort((a, b) => {
    const ka = `${a.filePath}::${a.name}`;
    const kb = `${b.filePath}::${b.name}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const cappedEntries = entryCandidates.slice(0, caps.maxEntries);

  const flows: UserFlow[] = [];
  const emittedIds = new Set<string>();

  for (const entry of cappedEntries) {
    const flags = { ambiguous: false };
    let truncated = false;

    const steps: FlowStep[] = [];
    const effects: FlowEffect[] = [];
    const visited = new Set<string>([entry.id]);

    function visit(card: FunctionCard, depth: number): void {
      const children = resolveChildren(card, flags);
      if (depth >= caps.maxDepth) {
        if (children.length > 0) truncated = true;
        return;
      }
      for (const child of children) {
        if (visited.has(child.id)) continue; // cycle + shared-tail dedupe
        if (steps.length >= caps.maxStepsPerFlow) {
          truncated = true;
          return;
        }
        visited.add(child.id);
        steps.push({ file: child.filePath, symbol: child.name, role: stepRole(child) });
        if (isEffectCard(child)) {
          effects.push({ file: child.filePath, symbol: child.name, kind: effectKind(child) });
        }
        visit(child, depth + 1);
      }
    }

    // An entry must have at least one resolvable out-edge to model a path.
    const entryChildren = resolveChildren(entry, flags);
    if (entryChildren.length === 0) continue;
    visit(entry, 0);

    const id = `flow:${entry.filePath}::${entry.name}`;
    if (emittedIds.has(id)) continue;
    emittedIds.add(id);

    let confidence = 100;
    if (truncated) confidence = Math.min(confidence, 70);
    if (flags.ambiguous) confidence = Math.min(confidence, 60);
    confidence = Math.max(confidence, 10);

    flows.push({
      id,
      name: entry.name,
      finality: entry.summary ?? entry.name,
      entry: {
        file: entry.filePath,
        symbol: entry.name,
        kind: entry.behavioralProfile === 'async' ? 'async' : 'side_effect',
      },
      steps,
      effects,
      confidence,
      unwired: effects.length === 0,
    });
  }

  flows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return flows.slice(0, caps.maxFlows);
}
