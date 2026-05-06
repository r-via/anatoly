// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Config } from '../schemas/config.js';
import { parseModelRef, type ConfigV3 } from '../schemas/config-v3.js';
import { isSystemLocalProvider } from '../rag/system-providers.js';
import { getV3Source } from './config-loader.js';

/** Per-run shape filters that narrow the active model set to what the
 * resolved invocation will actually call. All fields default to "include"
 * so callers that don't care about a particular axis stay backwards-compatible. */
export interface ActiveModelOptions {
  /** When false, drops embedding models and skips the rag.embedding hunk. */
  readonly enableRag?: boolean;
  /** When false, drops `models.deliberation` and `agents.deliberation`. */
  readonly enableDeliberation?: boolean;
  /** When set, restricts axis-model collection to the listed axis ids. */
  readonly axesFilter?: ReadonlyArray<string>;
}

/**
 * Walk the resolved Anatoly config and return every model identifier that
 * could be invoked at runtime — used to drive the pricing cache so we only
 * fetch tarifs for models the user actually exercises.
 *
 * Sources walked (in this order, before dedupe + sort):
 *   1. `config.models.{quality, fast, deliberation, code_summary?}`
 *   2. `config.agents.{scaffolding?, review?, deliberation?}`
 *   3. `config.axes.<axis>.model?`
 *   4. `config.rag.embedding.{code, nlp}?.model?`
 *
 * The {@link ActiveModelOptions} argument lets callers narrow this to the
 * actual run shape — e.g. `--no-rag` drops embeddings, `--no-deliberation`
 * drops the deliberation tier, `--axes utility,tests` restricts axis
 * overrides — so the strict pricing gate doesn't refuse to start over a
 * model that won't actually be invoked.
 *
 * The result is dedup'd and sorted ascending so hashes / cache keys derived
 * from the list are stable across runs.
 */
export function enumerateActiveModels(
  config: Config,
  options: ActiveModelOptions = {},
): string[] {
  // When the config originated from a v3 YAML, walk its declarative routing
  // section directly. v3 has no `models.*` / `agents.*` / `rag.embedding.*`
  // duplication — every active model is reachable through `routing` and
  // `evaluation.axes.<id>.model`, which keeps the inventory tighter and
  // avoids re-deriving the v2 mapping for the pricing gate.
  const v3 = getV3Source(config);
  if (v3) return enumerateActiveModelsV3(v3, options);

  return enumerateActiveModelsV2(config, options);
}

function enumerateActiveModelsV2(
  config: Config,
  options: ActiveModelOptions,
): string[] {
  const enableRag = options.enableRag !== false;
  const enableDeliberation = options.enableDeliberation !== false;
  const axesFilter = options.axesFilter;
  const seen = new Set<string>();

  // 1. Tiered LLM models (defaulted by the schema, always present)
  seen.add(config.models.quality);
  seen.add(config.models.fast);
  if (enableDeliberation) seen.add(config.models.deliberation);
  if (config.models.code_summary) seen.add(config.models.code_summary);

  // 2. Agentic overrides
  if (config.agents.scaffolding) seen.add(config.agents.scaffolding);
  if (config.agents.review) seen.add(config.agents.review);
  if (enableDeliberation && config.agents.deliberation) seen.add(config.agents.deliberation);

  // 3. Per-axis overrides
  for (const [id, axis] of Object.entries(config.axes)) {
    if (!axis?.model) continue;
    if (axesFilter && !axesFilter.includes(id)) continue;
    seen.add(axis.model);
  }

  // 4. Embedding models — only when an explicit model is set; 'auto' / absence
  //    means the runtime resolves a default at boot, which the cache handles
  //    via lookup-on-demand once that resolution happens.
  if (enableRag) {
    const embedding = config.rag.embedding;
    if (embedding?.code?.model) seen.add(embedding.code.model);
    if (embedding?.nlp?.model) seen.add(embedding.nlp.model);
  }

  return [...seen].sort();
}

function enumerateActiveModelsV3(v3: ConfigV3, options: ActiveModelOptions): string[] {
  const enableRag = options.enableRag !== false;
  const enableDeliberation = options.enableDeliberation !== false;
  const axesFilter = options.axesFilter;
  const seen = new Set<string>();

  // 1. Generation routing — quality, fast, summarization always; deliberation
  //    is gated by enableDeliberation (matches v2 behaviour).
  seen.add(v3.routing.generation.quality);
  seen.add(v3.routing.generation.fast);
  seen.add(v3.routing.generation.summarization);
  if (enableDeliberation) seen.add(v3.routing.generation.deliberation);

  // 2. Per-axis overrides
  for (const [id, axis] of Object.entries(v3.evaluation.axes)) {
    if (typeof axis === 'boolean') continue;
    if (!('model' in axis) || !axis.model) continue;
    if (axesFilter && !axesFilter.includes(id)) continue;
    seen.add(axis.model);
  }

  // 3. Embedding routing — only network providers go to the pricing cache.
  //    Local providers (ONNX in-process, or the auto-managed `local-advanced`
  //    GGUF Docker sidecar) have no upstream pricing entry and would trigger
  //    spurious warnings if included. Match by provider id, not URL — a user
  //    pointing a custom provider at their own localhost service is opting in
  //    to pricing lookups (and will get a clear warning if no entry exists).
  if (enableRag) {
    for (const ref of [v3.routing.embeddings.code, v3.routing.embeddings.text]) {
      const parsed = parseModelRef(ref);
      if (!parsed) continue;
      const provider = v3.providers[parsed.provider];
      if (!provider) continue;
      if (provider.transport === 'onnxruntime_node') continue;
      if (isSystemLocalProvider(parsed.provider)) continue;
      seen.add(ref);
    }
  }

  return [...seen].sort();
}
