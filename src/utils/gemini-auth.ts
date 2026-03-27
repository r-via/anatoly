// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import {
  Config,
  AuthType,
  getAuthTypeFromEnv,
  createSessionId,
} from '@google/gemini-cli-core';

/**
 * Attempts to initialize Gemini auth credentials.
 * Returns `true` if auth succeeds, `false` if it fails.
 *
 * This is a non-blocking check: on failure the caller should disable Gemini
 * for the current run and fall back to Claude-only mode.
 */
export async function checkGeminiAuth(
  projectRoot: string,
  model: string,
): Promise<boolean> {
  try {
    const config = new Config({
      sessionId: createSessionId(),
      targetDir: projectRoot,
      cwd: projectRoot,
      debugMode: false,
      model,
      userMemory: '',
      enableHooks: false,
      mcpEnabled: false,
      extensionsEnabled: false,
    });

    const authType = getAuthTypeFromEnv() || AuthType.LOGIN_WITH_GOOGLE;
    await config.refreshAuth(authType);
    await config.initialize();
    return true;
  } catch {
    return false;
  }
}
