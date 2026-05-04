// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Provider pricing cache.
 *
 * Replaces the old hardcoded `MODEL_PRICING` table with a runtime cache
 * sourced from upstream registries:
 *   - litellm `model_prices_and_context_window.json` (full snapshot via raw GitHub)
 *   - OpenRouter `/api/v1/models` (chat) and `/api/v1/embeddings/models`
 *
 * Both sources are queried with HTTP conditional requests (ETag /
 * If-Modified-Since), so steady-state runs after the first fetch only pay a
 * few hundred bytes per provider per session.
 *
 * The result is normalised into `.anatoly/pricing.json` keyed by the exact
 * model identifier the user has in their config (e.g. `anthropic/claude-sonnet-4-6`,
 * `mistral/codestral-embed-2505`, `openrouter/qwen/qwen3-embedding-8b`). At
 * lookup time `calculateCost` does a direct map read — no resolution,
 * no string juggling.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { extractProvider, stripPrefix } from '../core/transports/index.js';
import { AnatolyError, ERROR_CODES } from './errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pricing for a model, expressed per 1M tokens (USD). */
export interface ModelPricing {
  /** Cost per 1M input/prompt tokens. */
  readonly input: number;
  /** Cost per 1M output/completion tokens (0 for embedding models). */
  readonly output: number;
  /**
   * Cost per 1M cache-read input tokens. Undefined when the upstream registry
   * doesn't expose a separate cache-read rate (e.g. most non-Anthropic models,
   * current OpenRouter shape). Callers should fall back to {@link input} in
   * that case so the cache contribution isn't silently dropped.
   */
  readonly cacheReadInput?: number;
  /** Cost per 1M cache-creation input tokens. Optional, same fallback policy. */
  readonly cacheCreationInput?: number;
}

/** Origin of a pricing entry — used for traceability in the on-disk file. */
export type PricingSource = 'litellm' | 'openrouter';

interface NormalizedEntry extends ModelPricing {
  source: PricingSource;
}

interface NormalizedFile {
  generated_at: string;
  models: Record<string, NormalizedEntry>;
}

interface SourceMeta {
  etag?: string | null;
  last_modified?: string | null;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings/models';

/** Paths under projectRoot. Centralised so tests can introspect them. */
export const PRICING_PATHS = {
  normalized: '.anatoly/pricing.json',
  litellmRaw: '.anatoly/sources/litellm.json',
  litellmMeta: '.anatoly/sources/litellm.meta.json',
  openrouterChatRaw: '.anatoly/sources/openrouter-chat.json',
  openrouterChatMeta: '.anatoly/sources/openrouter-chat.meta.json',
  openrouterEmbeddingsRaw: '.anatoly/sources/openrouter-embeddings.json',
  openrouterEmbeddingsMeta: '.anatoly/sources/openrouter-embeddings.meta.json',
} as const;

// ---------------------------------------------------------------------------
// Module-level memo — populated by `ensurePricing` and lazily backfilled
// from disk by `lookupPrice` so synchronous call-sites stay synchronous.
// ---------------------------------------------------------------------------

let memoryCache: Record<string, NormalizedEntry> | null = null;
let warnedMissing = false;

/** Test seam — clears in-memory state so each test starts fresh. */
export function _resetPricingCache(): void {
  memoryCache = null;
  warnedMissing = false;
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

/**
 * Fetch a JSON resource with a conditional GET. Re-uses the cached body when
 * the upstream returns 304, refreshes both body and meta when it returns 200,
 * and surfaces network errors so the caller can decide whether to fall back
 * to the existing on-disk copy.
 */
async function fetchJsonConditional(
  url: string,
  bodyPath: string,
  metaPath: string,
): Promise<unknown> {
  const meta = readMetaIfExists(metaPath);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (meta?.etag) headers['If-None-Match'] = meta.etag;
  if (meta?.last_modified) headers['If-Modified-Since'] = meta.last_modified;

  const response = await fetch(url, { headers });

  if (response.status === 304 && existsSync(bodyPath)) {
    return JSON.parse(readFileSync(bodyPath, 'utf-8'));
  }

  if (!response.ok) {
    throw new Error(`pricing fetch ${url} failed: HTTP ${response.status}`);
  }

  const body = await response.text();
  ensureDir(dirname(bodyPath));
  writeFileSync(bodyPath, body);
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        etag: response.headers.get('etag'),
        last_modified: response.headers.get('last-modified'),
        fetched_at: new Date().toISOString(),
      } satisfies SourceMeta,
      null,
      2,
    ),
  );
  return JSON.parse(body);
}

function readMetaIfExists(path: string): SourceMeta | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SourceMeta;
  } catch {
    return null;
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

// ---------------------------------------------------------------------------
// Source loaders — fetch + parse, with disk fallback when network fails.
// ---------------------------------------------------------------------------

interface LitellmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}
type LitellmRaw = Record<string, LitellmEntry>;

interface OpenRouterEntry {
  id: string;
  pricing?: { prompt?: string; completion?: string };
}
interface OpenRouterPayload {
  data: OpenRouterEntry[];
}

async function loadLitellm(projectRoot: string): Promise<LitellmRaw | null> {
  const bodyPath = resolve(projectRoot, PRICING_PATHS.litellmRaw);
  const metaPath = resolve(projectRoot, PRICING_PATHS.litellmMeta);
  try {
    return (await fetchJsonConditional(LITELLM_URL, bodyPath, metaPath)) as LitellmRaw;
  } catch {
    if (existsSync(bodyPath)) {
      return JSON.parse(readFileSync(bodyPath, 'utf-8')) as LitellmRaw;
    }
    return null;
  }
}

async function loadOpenRouter(projectRoot: string): Promise<Map<string, OpenRouterEntry> | null> {
  const merged = new Map<string, OpenRouterEntry>();
  let anySuccess = false;

  for (const [url, bodyKey, metaKey] of [
    [OPENROUTER_CHAT_URL, PRICING_PATHS.openrouterChatRaw, PRICING_PATHS.openrouterChatMeta],
    [
      OPENROUTER_EMBEDDINGS_URL,
      PRICING_PATHS.openrouterEmbeddingsRaw,
      PRICING_PATHS.openrouterEmbeddingsMeta,
    ],
  ] as const) {
    const bodyPath = resolve(projectRoot, bodyKey);
    const metaPath = resolve(projectRoot, metaKey);
    let payload: OpenRouterPayload | null = null;
    try {
      payload = (await fetchJsonConditional(url, bodyPath, metaPath)) as OpenRouterPayload;
      anySuccess = true;
    } catch {
      if (existsSync(bodyPath)) {
        payload = JSON.parse(readFileSync(bodyPath, 'utf-8')) as OpenRouterPayload;
        anySuccess = true;
      }
    }
    if (payload?.data) {
      for (const entry of payload.data) merged.set(entry.id, entry);
    }
  }

  return anySuccess ? merged : null;
}

// ---------------------------------------------------------------------------
// Per-model resolution — given an anatoly model id, find its price in the
// source most likely to host it. The lookup tries multiple key shapes because
// litellm mixes bare keys (`claude-sonnet-4-6`) and provider-prefixed keys
// (`mistral/codestral-embed-2505`, `voyage/voyage-code-3`) in the same map.
// ---------------------------------------------------------------------------

function resolveLitellmPricing(modelId: string, raw: LitellmRaw): ModelPricing | null {
  const bare = stripPrefix(modelId);
  const candidates = uniq([bare, modelId, stripDateSuffix(bare), stripDateSuffix(modelId)]);
  for (const key of candidates) {
    const entry = raw[key];
    if (!entry || typeof entry.input_cost_per_token !== 'number') continue;
    return {
      input: entry.input_cost_per_token * 1_000_000,
      output: (entry.output_cost_per_token ?? 0) * 1_000_000,
      ...(typeof entry.cache_read_input_token_cost === 'number'
        ? { cacheReadInput: entry.cache_read_input_token_cost * 1_000_000 }
        : {}),
      ...(typeof entry.cache_creation_input_token_cost === 'number'
        ? { cacheCreationInput: entry.cache_creation_input_token_cost * 1_000_000 }
        : {}),
    };
  }
  return null;
}

function resolveOpenRouterPricing(
  modelId: string,
  merged: Map<string, OpenRouterEntry>,
): ModelPricing | null {
  // OpenRouter ids look like `qwen/qwen3-embedding-8b`. The user's anatoly id
  // would be `openrouter/qwen/qwen3-embedding-8b`, so stripping our prefix
  // yields the right OpenRouter id.
  const orId = stripPrefix(modelId);
  const entry = merged.get(orId);
  if (!entry?.pricing) return null;
  const prompt = parseFloat(entry.pricing.prompt ?? '');
  const completion = parseFloat(entry.pricing.completion ?? '');
  if (!Number.isFinite(prompt)) return null;
  return {
    input: prompt * 1_000_000,
    output: (Number.isFinite(completion) ? completion : 0) * 1_000_000,
  };
}

function stripDateSuffix(id: string): string {
  // `claude-haiku-4-5-20251001` → `claude-haiku-4-5`
  return id.replace(/-\d{8}$/, '');
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnsurePricingOptions {
  /** Optional structured logger; falls back to no-op. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * Fail-loud mode: when true, throws {@link AnatolyError} with code
   * `PRICING_INCOMPLETE` if any active model has no resolvable pricing.
   * Required for `run` and `estimate` so a missing entry can never silently
   * degrade cost reports to zero. Diagnostic commands (`init`, `providers`)
   * leave this off so they can show the user *what* is missing.
   */
  strict?: boolean;
}

/**
 * Resolve pricing for the given active model identifiers and persist the
 * result to `.anatoly/pricing.json`. Should be called once per run, after
 * `loadConfig`. Network failures degrade gracefully: existing on-disk caches
 * are preserved and the in-memory map is hydrated from whatever's available.
 */
export async function ensurePricing(
  activeModels: readonly string[],
  projectRoot: string,
  options: EnsurePricingOptions = {},
): Promise<void> {
  const log = options.log ?? (() => {});

  // Decide which sources to fetch — only hit OpenRouter when the user
  // actually has openrouter-prefixed models in their config.
  const needsOpenRouter = activeModels.some((m) => extractProvider(m) === 'openrouter');

  const litellm = await loadLitellm(projectRoot);
  if (!litellm) log('warn', 'pricing: litellm fetch failed and no cached snapshot — costs will be zero for non-OpenRouter models');

  const openrouter = needsOpenRouter ? await loadOpenRouter(projectRoot) : null;
  if (needsOpenRouter && !openrouter) {
    log('warn', 'pricing: openrouter fetch failed and no cached snapshot — costs will be zero for openrouter/* models');
  }

  const models: Record<string, NormalizedEntry> = {};
  const missing: string[] = [];
  for (const id of activeModels) {
    const useOR = extractProvider(id) === 'openrouter';
    const pricing = useOR
      ? openrouter
        ? resolveOpenRouterPricing(id, openrouter)
        : null
      : litellm
        ? resolveLitellmPricing(id, litellm)
        : null;
    if (pricing) {
      models[id] = { ...pricing, source: useOR ? 'openrouter' : 'litellm' };
    } else {
      missing.push(id);
      log('warn', `pricing: no entry resolved for "${id}" — calls will report cost = 0`);
    }
  }

  const file: NormalizedFile = {
    generated_at: new Date().toISOString(),
    models,
  };
  const outPath = resolve(projectRoot, PRICING_PATHS.normalized);
  ensureDir(dirname(outPath));
  writeFileSync(outPath, JSON.stringify(file, null, 2));

  memoryCache = models;
  warnedMissing = false;

  if (options.strict && missing.length > 0) {
    throw new AnatolyError(
      `pricing not resolvable for: ${missing.join(', ')}`,
      ERROR_CODES.PRICING_INCOMPLETE,
      false,
    );
  }
}

/**
 * Synchronous price lookup. Lazily hydrates the in-memory cache from
 * `.anatoly/pricing.json` if `ensurePricing` hasn't run this session. Returns
 * `null` when no entry is known, allowing callers to decide their fallback.
 */
export function lookupPrice(modelId: string, projectRoot?: string): ModelPricing | null {
  if (!memoryCache) hydrateFromDisk(projectRoot ?? process.cwd());
  if (!memoryCache) return null;

  const direct = memoryCache[modelId];
  if (direct) return toPricing(direct);

  // Tolerate minor drift between the active-model list at ensure-time and the
  // live model id at call-time (e.g. an unconfigured fallback). Walk the keys
  // looking for a stripped-prefix match before giving up.
  const bare = stripPrefix(modelId);
  for (const [key, entry] of Object.entries(memoryCache)) {
    if (stripPrefix(key) === bare) return toPricing(entry);
  }
  return null;
}

function toPricing(entry: NormalizedEntry): ModelPricing {
  return {
    input: entry.input,
    output: entry.output,
    ...(entry.cacheReadInput != null ? { cacheReadInput: entry.cacheReadInput } : {}),
    ...(entry.cacheCreationInput != null ? { cacheCreationInput: entry.cacheCreationInput } : {}),
  };
}

function hydrateFromDisk(projectRoot: string): void {
  const path = resolve(projectRoot, PRICING_PATHS.normalized);
  if (!existsSync(path)) {
    if (!warnedMissing) {
      warnedMissing = true;
      // Stay silent in tests; a single info-level write is enough in real runs.
    }
    return;
  }
  try {
    const file = JSON.parse(readFileSync(path, 'utf-8')) as NormalizedFile;
    memoryCache = file.models ?? {};
  } catch {
    memoryCache = {};
  }
}
