// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Shared TransportRouter factory for standalone CLI commands that make
 * LLM calls outside the main audit pipeline (docs arbitrate refresh,
 * init --scope suggestion, ...).
 *
 * Mirrors the per-command `buildRouter` helpers; new call sites should use
 * this instead of hand-rolling another copy. Lives in its own module (not the
 * transports barrel) to avoid an import cycle with the concrete transports.
 */

import type { Config } from '../../schemas/config.js';
import { TransportRouter, type ProviderModeConfig, type LlmTransport } from './index.js';
import { AnthropicTransport } from './anthropic-transport.js';
import { VercelSdkTransport } from './vercel-sdk-transport.js';

/** Build a mode-aware router from the loaded config. */
export function createCliRouter(config: Config): TransportRouter {
  const nativeTransports: Record<string, LlmTransport> = {
    anthropic: new AnthropicTransport(),
  };
  const providerModes: Record<string, ProviderModeConfig> = {};
  for (const [id, prov] of Object.entries(config.providers)) {
    if (prov) {
      providerModes[id] = {
        mode: prov.mode,
        single_turn: prov.single_turn,
        agents: prov.agents,
        concurrency: prov.concurrency,
      };
    }
  }
  return new TransportRouter({
    nativeTransports,
    vercelSdkTransport: new VercelSdkTransport(config),
    providerModes,
  });
}
