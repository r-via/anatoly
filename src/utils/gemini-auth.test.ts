// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @google/gemini-cli-core
// ---------------------------------------------------------------------------

const {
  mockRefreshAuth,
  mockInitialize,
  configInstances,
} = vi.hoisted(() => ({
  mockRefreshAuth: vi.fn().mockResolvedValue(undefined),
  mockInitialize: vi.fn().mockResolvedValue(undefined),
  configInstances: [] as unknown[],
}));

vi.mock('@google/gemini-cli-core', () => {
  class MockConfig {
    refreshAuth = mockRefreshAuth;
    initialize = mockInitialize;
    get geminiClient() {
      return {
        resetChat: vi.fn(),
        getChat: vi.fn().mockReturnValue({ setSystemInstruction: vi.fn() }),
        sendMessageStream: vi.fn(),
      };
    }
    constructor() {
      configInstances.push(this);
    }
  }
  return {
    Config: MockConfig,
    AuthType: { LOGIN_WITH_GOOGLE: 'oauth-personal' },
    getAuthTypeFromEnv: vi.fn().mockReturnValue(undefined),
    createSessionId: vi.fn().mockReturnValue('mock-session-id'),
  };
});

import { checkGeminiAuth } from './gemini-auth.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkGeminiAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configInstances.length = 0;
  });

  it('returns true when auth succeeds', async () => {
    const result = await checkGeminiAuth('/tmp/project', 'gemini-2.5-flash');
    expect(result).toBe(true);
  });

  it('initializes Config and calls refreshAuth + initialize', async () => {
    await checkGeminiAuth('/tmp/project', 'gemini-2.5-flash');
    expect(configInstances).toHaveLength(1);
    expect(mockRefreshAuth).toHaveBeenCalledTimes(1);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('returns false when refreshAuth throws', async () => {
    mockRefreshAuth.mockRejectedValueOnce(new Error('No Google credentials found'));
    const result = await checkGeminiAuth('/tmp/project', 'gemini-2.5-flash');
    expect(result).toBe(false);
  });

  it('returns false when initialize throws', async () => {
    mockInitialize.mockRejectedValueOnce(new Error('Initialization failed'));
    const result = await checkGeminiAuth('/tmp/project', 'gemini-2.5-flash');
    expect(result).toBe(false);
  });

  it('does not throw when auth fails — always returns boolean', async () => {
    mockRefreshAuth.mockRejectedValueOnce(new Error('Auth error'));
    await expect(checkGeminiAuth('/tmp/project', 'gemini-2.5-flash')).resolves.toBe(false);
  });
});
