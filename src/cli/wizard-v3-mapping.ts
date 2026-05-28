// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Pure translation from interactive wizard selections (v2-shaped) to the v3
 * `providers` + `routing.generation` blocks. Inverse of the providers/models
 * slice of [config-v3-adapter.ts](../schemas/config-v3-adapter.ts).
 *
 * Rules are specced in `_bmad-output/spec-wizard-2a-v2v3-mapping.md`. The v3
 * role to requirement map is authoritative in
 * [config-v3.ts](../schemas/config-v3.ts) (quality/fast/summarization =
 * single_turn, deliberation = agentic). No I/O, no validation.
 */

import { KNOWN_PROVIDERS } from '../core/providers/known-providers.js';
import type { ProviderSelection } from '../commands/init.js';

/**
 * Uniform default parallel-request budget written explicitly into every
 * network provider the wizard emits. Kept in the generated `.anatoly.yml`
 * (not left to a hidden Zod default) so users see and can tune it. Matches
 * `GenericProviderConfigSchema`'s default in
 * [config.ts](../schemas/config.ts).
 */
export const DEFAULT_PROVIDER_CONCURRENCY = 8;

export interface V3ProviderEntry {
  transport: 'claude_agent_sdk' | 'openai_compatible';
  auth: 'oauth' | 'api_key';
  env_key?: string;
  base_url?: string;
  concurrency: number;
  models: string[];
}

export interface WizardV3Mapping {
  providers: Record<string, V3ProviderEntry>;
  routingGeneration: { quality: string; fast: string; deliberation: string; summarization: string };
  /** Non-fatal downgrades (e.g. oauth requested on an openai_compatible provider). */
  warnings: string[];
}

type Auth = 'oauth' | 'api_key';
type Transport = V3ProviderEntry['transport'];

interface ModelsInput {
  quality: string;
  fast: string;
  deliberation: string;
  code_summary?: string;
}

/** v3 transport for a provider name. */
function transportFor(name: string): Transport {
  if (name === 'anthropic') return 'claude_agent_sdk';
  return 'openai_compatible';
}

/** env var name for a provider (catalog, else `${NAME}_API_KEY`). */
function envKeyFor(name: string): string {
  return KNOWN_PROVIDERS[name]?.env_key ?? `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/** `subscription` → oauth, `api` → api_key. */
function authFor(mode: 'subscription' | 'api'): Auth {
  return mode === 'subscription' ? 'oauth' : 'api_key';
}

/** Split a `provider/model` ref into its parts (first slash). */
function splitRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  if (i < 0) return { provider: '', model: ref };
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

/**
 * Build one concrete v3 provider entry (transport/auth/env_key/base_url),
 * downgrading an invalid oauth-on-openai_compatible to api_key and recording
 * a warning. `models` is filled by the caller.
 */
function makeEntry(name: string, auth: Auth, warnings: string[]): V3ProviderEntry {
  const transport = transportFor(name);
  let effectiveAuth = auth;
  if (auth === 'oauth' && transport === 'openai_compatible') {
    effectiveAuth = 'api_key';
    warnings.push(
      `Provider "${name}" requested subscription (oauth) but its transport (openai_compatible) only supports API keys; using api_key.`,
    );
  }
  const entry: V3ProviderEntry = {
    transport,
    auth: effectiveAuth,
    concurrency: DEFAULT_PROVIDER_CONCURRENCY,
    models: [],
  };
  if (effectiveAuth === 'api_key') {
    entry.env_key = envKeyFor(name);
  }
  const baseUrl = KNOWN_PROVIDERS[name]?.base_url;
  if (baseUrl) entry.base_url = baseUrl;
  return entry;
}

/**
 * Translate wizard provider selections + model role assignments into the v3
 * providers block and the routing.generation map. See the module doc.
 */
export function wizardProvidersToV3(
  providers: Map<string, ProviderSelection>,
  models: ModelsInput,
): WizardV3Mapping {
  const warnings: string[] = [];
  const out: Record<string, V3ProviderEntry> = {};

  // Resolve, per provider name, which v3 entry name a single_turn role and an
  // agentic role should target. Without split they are the same.
  const singleTurnEntryName = new Map<string, string>();
  const agenticEntryName = new Map<string, string>();

  for (const [name, sel] of providers) {
    const stAuth = authFor(sel.single_turn ?? sel.mode);
    const agAuth = authFor(sel.agents ?? sel.mode);

    if (stAuth === agAuth) {
      // No effective split: one entry.
      out[name] = makeEntry(name, stAuth, warnings);
      singleTurnEntryName.set(name, name);
      agenticEntryName.set(name, name);
    } else {
      // Split: P (single_turn auth) + P-agentic (agentic auth).
      const agenticName = `${name}-agentic`;
      out[name] = makeEntry(name, stAuth, warnings);
      out[agenticName] = makeEntry(name, agAuth, warnings);
      singleTurnEntryName.set(name, name);
      agenticEntryName.set(name, agenticName);
    }
  }

  // Route each generation role. quality/fast/summarization are single_turn;
  // deliberation is agentic (config-v3.ts:524-527).
  const summarizationRef = models.code_summary ?? models.fast;
  const roleRefs: Array<[keyof WizardV3Mapping['routingGeneration'], string, 'single' | 'agentic']> = [
    ['quality', models.quality, 'single'],
    ['fast', models.fast, 'single'],
    ['deliberation', models.deliberation, 'agentic'],
    ['summarization', summarizationRef, 'single'],
  ];

  const routingGeneration = {} as WizardV3Mapping['routingGeneration'];
  for (const [role, ref, kind] of roleRefs) {
    const { provider, model } = splitRef(ref);
    const entryName =
      kind === 'agentic'
        ? agenticEntryName.get(provider) ?? provider
        : singleTurnEntryName.get(provider) ?? provider;
    routingGeneration[role] = `${entryName}/${model}`;
    const entry = out[entryName];
    if (entry && !entry.models.includes(model)) entry.models.push(model);
  }

  return { providers: out, routingGeneration, warnings };
}
