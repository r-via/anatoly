// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Deterministic record/replay transport double.
 *
 * This is the orchestration safety net's foundation (Orchestration Remediation
 * Plan, doc 11, PR 1). It wraps any {@link LlmTransport} and, depending on the
 * `ANATOLY_TRANSPORT` env var:
 *
 * - `record`: delegates every call to the real inner transport, then persists
 *   `{requestKey -> LlmResponse}` to a cassette file. Use this to refresh the
 *   golden cassette against live models (needs real provider credentials).
 * - `replay`: serves canned responses from the cassette by request key and
 *   NEVER touches the network or the inner transport. A cassette miss throws a
 *   loud, debuggable error so the golden fails visibly rather than silently.
 *
 * When `ANATOLY_TRANSPORT` is unset (production default) the wrapping is inert:
 * {@link maybeWrapTransport} returns the inner transport unchanged.
 *
 * Determinism: the request key is a SHA-256 over a canonicalized projection of
 * the request (kind + provider + bare model + normalized system/user text).
 * Normalization strips the dominant nondeterministic tokens so a cassette
 * recorded in one temp project replays in another:
 *   - the absolute `projectRoot` path (replaced with `<ROOT>`)
 *   - ISO-8601 timestamps
 *   - 13+ digit epoch numbers (e.g. the `tier3-shard-${Date.now()}` prefix)
 *
 * Boundary (documented, not a bug): in `replay` mode the inner transport's
 * `recordLlmCall()` / `initConvDump()` side effects do not fire (the inner
 * transport is never invoked). The orchestration golden asserts the phase
 * sequence, gate decisions, `phaseDurations` keys and handoff values, none of
 * which depend on the D.4 ledger or D.2 dumps being populated under replay. If
 * a future PR needs cost-ledger fidelity under replay, emit it from here then.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LlmTransport, LlmRequest, LlmResponse, AgenticRequest } from './index.js';
import { stripPrefix, extractProvider } from './index.js';

export type RecordingMode = 'record' | 'replay';

/** One cassette entry: the canned response plus human-debuggable metadata. */
interface CassetteEntry {
  kind: 'query' | 'agentic';
  provider: string;
  model: string;
  /** Truncated previews so a cassette miss is diagnosable by eye. */
  preview: { system: string; user: string };
  response: LlmResponse;
}

interface CassetteFile {
  version: 1;
  entries: Record<string, CassetteEntry>;
}

const CASSETTE_VERSION = 1 as const;
const PREVIEW_LEN = 200;

/** Resolve the active recording mode from the environment, if any. */
export function recordingModeFromEnv(): RecordingMode | undefined {
  const v = process.env.ANATOLY_TRANSPORT;
  return v === 'record' || v === 'replay' ? v : undefined;
}

function cassettePathFromEnv(): string {
  const p = process.env.ANATOLY_TRANSPORT_CASSETTE;
  if (!p) {
    throw new Error(
      'ANATOLY_TRANSPORT is set but ANATOLY_TRANSPORT_CASSETTE (cassette file path) is not',
    );
  }
  return p;
}

/**
 * Strip the dominant nondeterministic tokens so a key recorded in one temp
 * project root replays in another. Conservative on purpose: only volatile
 * tokens are masked, semantic content is untouched.
 */
function normalize(text: string, projectRoot: string): string {
  let out = text;
  if (projectRoot) {
    out = out.split(projectRoot).join('<ROOT>');
  }
  // ISO-8601 timestamps (2026-05-17T08:50:11.586Z and date-only variants).
  out = out.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<TS>');
  // Long epoch-style digit runs (tier3-shard-1747... etc.).
  out = out.replace(/\d{13,}/g, '<N>');
  return out;
}

function keyFor(
  kind: 'query' | 'agentic',
  params: LlmRequest,
): string {
  const provider = extractProvider(params.model);
  const canonical = JSON.stringify({
    kind,
    provider,
    model: stripPrefix(params.model),
    system: normalize(params.systemPrompt, params.projectRoot),
    user: normalize(params.userMessage, params.projectRoot),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function loadCassette(path: string): CassetteFile {
  if (!existsSync(path)) {
    return { version: CASSETTE_VERSION, entries: {} };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CassetteFile;
  if (parsed.version !== CASSETTE_VERSION) {
    throw new Error(
      `cassette ${path}: unsupported version ${parsed.version} (expected ${CASSETTE_VERSION})`,
    );
  }
  return parsed;
}

function persistCassette(path: string, cassette: CassetteFile): void {
  mkdirSync(dirname(path), { recursive: true });
  // Stable key order keeps the committed cassette diff-friendly.
  const ordered: Record<string, CassetteEntry> = {};
  for (const k of Object.keys(cassette.entries).sort()) {
    ordered[k] = cassette.entries[k];
  }
  writeFileSync(
    path,
    JSON.stringify({ version: CASSETTE_VERSION, entries: ordered }, null, 2) + '\n',
  );
}

/**
 * An {@link LlmTransport} that records or replays calls against a cassette.
 * Delegates `provider` / `supports` to the wrapped transport so router
 * resolution and dispatch are unchanged.
 */
export class RecordingTransport implements LlmTransport {
  private readonly inner: LlmTransport;
  private readonly mode: RecordingMode;
  private readonly cassettePath: string;
  private cassette: CassetteFile;

  constructor(
    inner: LlmTransport,
    opts: { mode: RecordingMode; cassettePath: string },
  ) {
    this.inner = inner;
    this.mode = opts.mode;
    this.cassettePath = opts.cassettePath;
    this.cassette = loadCassette(this.cassettePath);
  }

  get provider(): string {
    return this.inner.provider;
  }

  supports(model: string): boolean {
    return this.inner.supports(model);
  }

  async query(params: LlmRequest): Promise<LlmResponse> {
    return this.handle('query', params, () => this.inner.query(params));
  }

  async agenticQuery(params: AgenticRequest): Promise<LlmResponse> {
    if (!this.inner.agenticQuery) {
      throw new Error(
        `RecordingTransport: wrapped transport '${this.inner.provider}' has no agenticQuery`,
      );
    }
    const innerAgentic = this.inner.agenticQuery.bind(this.inner);
    return this.handle('agentic', params, () => innerAgentic(params));
  }

  private async handle(
    kind: 'query' | 'agentic',
    params: LlmRequest,
    invokeInner: () => Promise<LlmResponse>,
  ): Promise<LlmResponse> {
    const key = keyFor(kind, params);

    if (this.mode === 'replay') {
      const entry = this.cassette.entries[key];
      if (!entry) {
        throw new Error(
          `cassette miss [${kind}] key=${key}\n` +
            `  cassette: ${this.cassettePath}\n` +
            `  provider: ${extractProvider(params.model)} model: ${stripPrefix(params.model)}\n` +
            `  system: ${preview(params.systemPrompt)}\n` +
            `  user: ${preview(params.userMessage)}\n` +
            `  (run with ANATOLY_TRANSPORT=record against live models to capture it)`,
        );
      }
      return entry.response;
    }

    // record: delegate to the real transport, then persist.
    const response = await invokeInner();
    this.cassette.entries[key] = {
      kind,
      provider: extractProvider(params.model),
      model: stripPrefix(params.model),
      preview: {
        system: preview(params.systemPrompt),
        user: preview(params.userMessage),
      },
      response,
    };
    persistCassette(this.cassettePath, this.cassette);
    return response;
  }
}

function preview(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > PREVIEW_LEN ? oneLine.slice(0, PREVIEW_LEN) + '…' : oneLine;
}

/**
 * Wrap a transport for record/replay iff `ANATOLY_TRANSPORT` is set. In
 * production (env unset) this is the identity function, so the seam is inert.
 * Called from the {@link TransportRouter} constructor so all router build
 * sites are covered with zero changes to command code.
 */
export function maybeWrapTransport(inner: LlmTransport): LlmTransport {
  const mode = recordingModeFromEnv();
  if (!mode) return inner;
  return new RecordingTransport(inner, { mode, cassettePath: cassettePathFromEnv() });
}
