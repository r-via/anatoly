// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Adapter from v3 config (the new declarative shape) to v2 config (the shape
 * still consumed by every helper in `src/`). Phase B uses this to bridge the
 * two formats so `version: 3` YAMLs can be loaded today without touching any
 * downstream consumer.
 *
 * The adapter is a pure transform — no I/O, no validation. It assumes its
 * input has already passed `ConfigV3Schema.parse()`. The output is shaped to
 * pass `ConfigSchema.parse()` from `src/schemas/config.ts`, so the loader can
 * round-trip it back through the v2 schema for default-filling and emit a
 * fully-typed `Config` object.
 *
 * Mapping summary:
 * - `providers.<name>` (network only) → `providers.<name>` with `mode` derived
 *   from `auth` (oauth → subscription, api_key → api). ONNX providers are
 *   skipped (no v2 transport). Local-advanced (openai_compatible + localhost
 *   base_url) is kept since v2 supports it through `rag.embedding`.
 * - `routing.generation.{quality,fast,deliberation,summarization}` → `models.*`
 *   (with `summarization` mapped to `models.code_summary`).
 * - `routing.embeddings.{code,text}` → `rag.embedding.{code,nlp}` for network
 *   providers; for ONNX providers the model id is set on `rag.{code,nlp}_model`.
 * - `evaluation.axes.<id>` (bool or object) → `axes.<id>` with `enabled`/`model`/
 *   `skip` preserved. The documentation axis's `docs_path` and `module_mapping`
 *   are lifted out into the top-level `documentation` section.
 * - `runtime.*` → spread across v2's `runtime`, `agents.max_turns`,
 *   `rag.code_weight`, `output.max_runs`, and `logging.*`.
 */

import { parseModelRef, type ConfigV3 } from './config-v3.js';

/** Max provider concurrency accepted by v2's schemas (Anthropic, Google, catchall). */
const V2_MAX_PROVIDER_CONCURRENCY = 32;
/** Max runtime concurrency accepted by v2's RuntimeConfigSchema. */
const V2_MAX_RUNTIME_CONCURRENCY = 10;

/* eslint-disable @typescript-eslint/no-explicit-any */
type LooseRecord = Record<string, any>;

/**
 * Translate a v3 config into the shape expected by `ConfigSchema` (v2). The
 * caller is expected to feed the result back through `ConfigSchema.parse()`
 * to fill defaults and produce the final typed `Config`.
 */
export function adaptV3ToV2(v3: ConfigV3): LooseRecord {
  const v2: LooseRecord = {};

  // 1. providers — only network providers (ONNX is local, lifted to rag.*)
  v2.providers = adaptProviders(v3);

  // 2. models — derived from routing.generation (already prefixed)
  v2.models = {
    quality: v3.routing.generation.quality,
    fast: v3.routing.generation.fast,
    deliberation: v3.routing.generation.deliberation,
    code_summary: v3.routing.generation.summarization,
  };

  // 3. agents.max_turns lives at v3.runtime.agents.max_turns
  v2.agents = {
    enabled: true,
    max_turns: v3.runtime.agents.max_turns,
  };

  // 4. runtime numeric knobs (concurrency clamped — v2's limit is tighter)
  v2.runtime = {
    concurrency: Math.min(v3.runtime.concurrency, V2_MAX_RUNTIME_CONCURRENCY),
    timeout_per_file: v3.runtime.timeout_per_file,
    max_retries: v3.runtime.max_retries,
    min_confidence: v3.runtime.min_confidence,
    max_stop_iterations: v3.runtime.max_stop_iterations,
  };

  // 5. rag — embedding routing (with local vs network split)
  v2.rag = adaptRag(v3);

  // 6. axes — bool or object normalized; documentation axis stripped of its
  //    docs_path / module_mapping (those move to documentation section below)
  v2.axes = adaptAxes(v3);

  // 7. documentation — extracted from the documentation axis (if object form)
  const documentation = adaptDocumentation(v3);
  if (documentation) v2.documentation = documentation;

  // 8. output (max_runs) and logging
  if (v3.runtime.output.max_runs !== undefined) {
    v2.output = { max_runs: v3.runtime.output.max_runs };
  }
  v2.logging = {
    level: v3.runtime.logging.level,
    pretty: v3.runtime.logging.pretty,
    ...(v3.runtime.logging.file !== undefined ? { file: v3.runtime.logging.file } : {}),
  };

  // 9. inherited unchanged sections
  v2.project = v3.project;
  v2.scan = v3.scan;
  v2.coverage = v3.coverage;
  v2.badge = v3.badge;
  v2.search = v3.search;
  if (v3.notifications) v2.notifications = v3.notifications;

  return v2;
}

/**
 * Map each v3 provider into a v2-shaped entry. ONNX providers are dropped:
 * they don't fit v2's `mode: 'subscription' | 'api'` model and are recovered
 * from `rag.{code,nlp}_model` instead.
 */
function adaptProviders(v3: ConfigV3): LooseRecord {
  const out: LooseRecord = {};
  for (const [name, p] of Object.entries(v3.providers)) {
    if (p.transport === 'onnxruntime_node') continue;

    const mode = p.auth === 'oauth' ? 'subscription' : 'api';
    const entry: LooseRecord = { mode };
    if (p.concurrency !== undefined) {
      entry.concurrency = Math.min(p.concurrency, V2_MAX_PROVIDER_CONCURRENCY);
    }
    if (p.env_key !== undefined) entry.env_key = p.env_key;
    if (p.base_url !== undefined) entry.base_url = p.base_url;
    out[name] = entry;
  }
  return out;
}

/**
 * Build v2's `rag` section from v3's embedding routing. Network providers feed
 * `rag.embedding.{code,nlp}`; ONNX providers feed `rag.{code,nlp}_model` with
 * the model id directly. `rag.code_weight` carries v3's `code_share`.
 */
function adaptRag(v3: ConfigV3): LooseRecord {
  const rag: LooseRecord = {
    enabled: true,
    code_weight: v3.runtime.rag.code_share,
  };

  const codeRef = parseModelRef(v3.routing.embeddings.code);
  const textRef = parseModelRef(v3.routing.embeddings.text);
  if (!codeRef || !textRef) return rag; // unreachable post-validation

  const codeProvider = v3.providers[codeRef.provider]!;
  const textProvider = v3.providers[textRef.provider]!;

  const embedding: LooseRecord = {};

  if (codeProvider.transport === 'onnxruntime_node') {
    rag.code_model = codeRef.model;
  } else {
    rag.code_model = 'auto';
    embedding.code = buildEmbeddingEntry(codeRef.provider, codeRef.model, codeProvider);
  }

  if (textProvider.transport === 'onnxruntime_node') {
    rag.nlp_model = textRef.model;
  } else {
    rag.nlp_model = 'auto';
    embedding.nlp = buildEmbeddingEntry(textRef.provider, textRef.model, textProvider);
  }

  if (Object.keys(embedding).length > 0) rag.embedding = embedding;
  return rag;
}

function buildEmbeddingEntry(
  providerId: string,
  model: string,
  provider: { base_url?: string; env_key?: string },
): LooseRecord {
  const entry: LooseRecord = { provider: providerId, model };
  if (provider.base_url !== undefined) entry.base_url = provider.base_url;
  if (provider.env_key !== undefined) entry.env_key = provider.env_key;
  return entry;
}

/**
 * Translate v3's `evaluation.axes` (each entry is bool or object) into v2's
 * `axes` (each entry is `{ enabled, model?, skip? }`). The documentation
 * axis's `docs_path` and `module_mapping` are not retained here — they are
 * lifted into v2's top-level `documentation` section by `adaptDocumentation`.
 */
function adaptAxes(v3: ConfigV3): LooseRecord {
  const out: LooseRecord = {};
  for (const [axisId, axis] of Object.entries(v3.evaluation.axes)) {
    if (typeof axis === 'boolean') {
      out[axisId] = { enabled: axis };
      continue;
    }
    const entry: LooseRecord = { enabled: axis.enabled };
    if ('model' in axis && axis.model !== undefined) entry.model = axis.model;
    if ('skip' in axis && axis.skip !== undefined) entry.skip = axis.skip;
    out[axisId] = entry;
  }
  return out;
}

/**
 * Lift documentation-axis–specific fields (`docs_path`, `module_mapping`) into
 * v2's top-level `documentation` section. Returns null when the axis is in
 * bool form (no extra fields).
 */
function adaptDocumentation(v3: ConfigV3): LooseRecord | null {
  const axis = v3.evaluation.axes.documentation;
  if (typeof axis === 'boolean') return null;
  const out: LooseRecord = {};
  if ('docs_path' in axis && axis.docs_path !== undefined) out.docs_path = axis.docs_path;
  if ('module_mapping' in axis && axis.module_mapping !== undefined) {
    out.module_mapping = axis.module_mapping;
  }
  return Object.keys(out).length > 0 ? out : null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
