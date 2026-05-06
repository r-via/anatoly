// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Names of the auto-managed local embedding providers Anatoly writes into a v3
 * `.anatoly.yml` (see `src/commands/local-embeddings.ts`). Used to distinguish
 * them from third-party external providers in resolution / pricing / display
 * logic — checking by provider name is more robust than parsing `base_url`.
 */
export const SYSTEM_LOCAL_PROVIDERS = ['local-advanced', 'local-lite'] as const;
export type SystemLocalProvider = typeof SYSTEM_LOCAL_PROVIDERS[number];

export function isSystemLocalProvider(id: string | undefined): id is SystemLocalProvider {
  return id !== undefined && (SYSTEM_LOCAL_PROVIDERS as readonly string[]).includes(id);
}
