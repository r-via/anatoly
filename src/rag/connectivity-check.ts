// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Pre-flight connectivity check for the resolved RAG embedding backend.
 *
 * Validates — before the indexer runs — that the active backend can actually
 * produce embeddings end-to-end:
 *  - `lite` (ONNX, in-process): no I/O — emits a confirmation line.
 *  - `advanced-gguf` (local Docker llama.cpp): probes both axes via the SDK so
 *    `pre_hook` triggers `ensureModel` and the swap, exercising the hot-swap
 *    that the run will rely on. Order is **NLP first, then code** so the code
 *    container is left hot — the indexer starts with the code phase, so
 *    finishing the probe on `code` saves one extra swap (~15-60 s of VRAM
 *    reload) right before real work begins.
 *  - `external` (third-party SDK): fires one short embedding per axis to catch
 *    bad keys, wrong base URL, or unsupported model names before any real work
 *    starts.
 *
 * Failures are reported via {@link ConnectivityFailure}; callers decide whether
 * to translate that into an `AnatolyError`. A fixed probe text is used so the
 * call cost stays in the single-digit-token range on external providers.
 */

import { embed } from 'ai';
import { getVercelEmbeddingModel } from './sdk-embedding.js';
import type { ResolvedModels, EmbeddingBackend } from './hardware-detect.js';

const PROBE_TEXT = 'anatoly connectivity probe';

export interface ProbeResult {
  axis: 'code' | 'nlp';
  provider: string | undefined;
  model: string;
  dim: number;
  durationMs: number;
}

export interface ConnectivityFailure {
  axis: 'code' | 'nlp';
  provider: string | undefined;
  model: string;
  cause: Error;
}

export type ConnectivityCheckOutcome =
  | { ok: true; backend: EmbeddingBackend; probes: ProbeResult[] }
  | { ok: false; backend: EmbeddingBackend; failure: ConnectivityFailure };

/**
 * Run the pre-flight probe for the resolved backend.
 *
 * Containers (advanced-gguf) must already be started by the caller — this
 * function never starts or stops Docker, so it composes cleanly on top of the
 * existing `runRagPhase` lifecycle.
 *
 * @param resolved - Output of `resolveEmbeddingModels`.
 * @param log - Status sink (use the run logger or a stdout writer).
 */
export async function runConnectivityCheck(
  resolved: ResolvedModels,
  log: (message: string) => void,
): Promise<ConnectivityCheckOutcome> {
  // Lite (and the legacy advanced-fp16 alias which falls back to lite at
  // runtime) runs ONNX in-process — there is nothing to connect to. The
  // models are loaded lazily on first embed; checking them here would be
  // duplicate work without any failure mode worth surfacing pre-indexer.
  if (resolved.backend === 'lite' || resolved.backend === 'advanced-fp16') {
    log('RAG · lite · ok');
    return { ok: true, backend: resolved.backend, probes: [] };
  }

  if (resolved.backend === 'advanced-gguf') {
    log('RAG · advanced-gguf · probing local containers (NLP first, then code swap)…');
    return probePair(resolved, log);
  }

  // external
  log(
    `RAG · external · probing ${resolved.codeProvider}/${resolved.codeModel} (code) and `
    + `${resolved.nlpProvider}/${resolved.nlpModel} (nlp)…`,
  );
  return probePair(resolved, log);
}

async function probePair(
  resolved: ResolvedModels,
  log: (message: string) => void,
): Promise<ConnectivityCheckOutcome> {
  // For advanced-gguf the order matters: probe NLP first so the *code*
  // container is hot when the indexer starts (which begins with the code
  // phase). For external/lite the order is irrelevant but stays consistent.
  const order = resolved.backend === 'advanced-gguf'
    ? ['nlp', 'code'] as const
    : ['code', 'nlp'] as const;
  const probesByAxis = new Map<'code' | 'nlp', ProbeResult>();
  for (const axis of order) {
    const result = await probeOne(resolved, axis, log);
    if (!result.ok) {
      return { ok: false, backend: resolved.backend, failure: result.failure };
    }
    probesByAxis.set(axis, result.probe);
  }
  const codeProbe = probesByAxis.get('code')!;
  const nlpProbe = probesByAxis.get('nlp')!;
  log(
    `RAG · ${resolved.backend} · ok (`
    + `code ${codeProbe.dim}d in ${codeProbe.durationMs}ms, `
    + `nlp ${nlpProbe.dim}d in ${nlpProbe.durationMs}ms)`,
  );
  return { ok: true, backend: resolved.backend, probes: [codeProbe, nlpProbe] };
}

async function probeOne(
  resolved: ResolvedModels,
  axis: 'code' | 'nlp',
  log: (message: string) => void,
): Promise<{ ok: true; probe: ProbeResult } | { ok: false; failure: ConnectivityFailure }> {
  const model = axis === 'code' ? resolved.codeModel : resolved.nlpModel;
  const provider = axis === 'code' ? resolved.codeProvider : resolved.nlpProvider;
  const baseUrl = axis === 'code' ? resolved.codeBaseUrl : resolved.nlpBaseUrl;
  const envKey = axis === 'code' ? resolved.codeEnvKey : resolved.nlpEnvKey;

  if (!provider) {
    return {
      ok: false,
      failure: {
        axis,
        provider: undefined,
        model,
        cause: new Error(`No provider resolved for ${axis} axis`),
      },
    };
  }

  log(`  ${axis}: ${provider}/${model} → probing…`);
  const start = Date.now();
  try {
    const sdkModel = getVercelEmbeddingModel(axis, model, {
      provider,
      base_url: baseUrl,
      env_key: envKey ?? undefined,
    });
    const { embedding } = await embed({ model: sdkModel, value: PROBE_TEXT });
    const durationMs = Date.now() - start;
    log(`  ${axis}: ${provider}/${model} → ${embedding.length}d (${durationMs}ms)`);
    return {
      ok: true,
      probe: { axis, provider, model, dim: embedding.length, durationMs },
    };
  } catch (err) {
    return {
      ok: false,
      failure: {
        axis,
        provider,
        model,
        cause: err instanceof Error ? err : new Error(String(err)),
      },
    };
  }
}
