// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Config } from '../schemas/config.js';

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
 * The result is dedup'd and sorted ascending so hashes / cache keys derived
 * from the list are stable across runs.
 */
export function enumerateActiveModels(config: Config): string[] {
  const seen = new Set<string>();

  // 1. Tiered LLM models (defaulted by the schema, always present)
  seen.add(config.models.quality);
  seen.add(config.models.fast);
  seen.add(config.models.deliberation);
  if (config.models.code_summary) seen.add(config.models.code_summary);

  // 2. Agentic overrides
  if (config.agents.scaffolding) seen.add(config.agents.scaffolding);
  if (config.agents.review) seen.add(config.agents.review);
  if (config.agents.deliberation) seen.add(config.agents.deliberation);

  // 3. Per-axis overrides
  for (const axis of Object.values(config.axes)) {
    if (axis?.model) seen.add(axis.model);
  }

  // 4. Embedding models — only when an explicit model is set; 'auto' / absence
  //    means the runtime resolves a default at boot, which the cache handles
  //    via lookup-on-demand once that resolution happens.
  const embedding = config.rag.embedding;
  if (embedding?.code?.model) seen.add(embedding.code.model);
  if (embedding?.nlp?.model) seen.add(embedding.nlp.model);

  return [...seen].sort();
}
