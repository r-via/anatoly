// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { classifyDownloadError, promptDownloadRecovery, type DownloadErrorKind, type RecoveryChoice } from './download-recovery.js';

// ---------------------------------------------------------------------------
// Mock @clack/prompts
// ---------------------------------------------------------------------------

const selectMock = vi.fn<(opts: { message: string; options: Array<{ value: string }> }) => Promise<string>>();
const confirmMock = vi.fn<(opts: { message: string }) => Promise<boolean>>();
const noteMock = vi.fn();
const cancelMock = vi.fn();

vi.mock('@clack/prompts', () => ({
  select: (opts: { message: string; options: Array<{ value: string }> }) => selectMock(opts),
  confirm: (opts: { message: string }) => confirmMock(opts),
  note: (...args: unknown[]) => noteMock(...args),
  cancel: (...args: unknown[]) => cancelMock(...args),
  isCancel: (val: unknown) => typeof val === 'symbol',
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// classifyDownloadError tests
// ---------------------------------------------------------------------------

describe('classifyDownloadError', () => {
  it('classifies ENOSPC as disk-full', () => {
    const err = Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' });
    expect(classifyDownloadError(err)).toBe('disk-full');
  });

  it('classifies ECONNREFUSED as network', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyDownloadError(err)).toBe('network');
  });

  it('classifies ETIMEDOUT as network', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(classifyDownloadError(err)).toBe('network');
  });

  it('classifies ENETUNREACH as network', () => {
    const err = Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' });
    expect(classifyDownloadError(err)).toBe('network');
  });

  it('classifies ENOTFOUND as network', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    expect(classifyDownloadError(err)).toBe('network');
  });

  it('classifies fetch failed as network', () => {
    const err = new Error('fetch failed');
    expect(classifyDownloadError(err)).toBe('network');
  });

  it('classifies SHA-256 verification failed as sha-mismatch', () => {
    const err = new Error('Post-download SHA-256 verification failed');
    expect(classifyDownloadError(err)).toBe('sha-mismatch');
  });

  it('classifies docker daemon message as docker', () => {
    const err = new Error('Cannot connect to the Docker daemon');
    expect(classifyDownloadError(err)).toBe('docker');
  });

  it('classifies unknown errors as unknown', () => {
    const err = new Error('some random error');
    expect(classifyDownloadError(err)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// promptDownloadRecovery tests
// ---------------------------------------------------------------------------

describe('promptDownloadRecovery', () => {
  beforeEach(() => {
    selectMock.mockReset();
    confirmMock.mockReset();
    noteMock.mockReset();
    cancelMock.mockReset();
  });

  const baseOpts = (kind: DownloadErrorKind) => ({
    kind,
    error: new Error('test error'),
    isTTY: true,
    defaultsSettings: false,
  });

  // AC: --defaults-settings → auto-fallback without prompt
  it('returns continue-lite without prompt when defaultsSettings is true', async () => {
    const result = await promptDownloadRecovery({ ...baseOpts('network'), defaultsSettings: true });
    expect(result).toBe('continue-lite');
    expect(selectMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  // AC: non-TTY → auto-fallback without prompt
  it('returns continue-lite without prompt when isTTY is false', async () => {
    const result = await promptDownloadRecovery({ ...baseOpts('network'), isTTY: false });
    expect(result).toBe('continue-lite');
    expect(selectMock).not.toHaveBeenCalled();
  });

  // AC: network error → p.note + p.select with 3 options
  it('shows network error note and select for network errors', async () => {
    selectMock.mockResolvedValueOnce('retry');
    const result = await promptDownloadRecovery(baseOpts('network'));
    expect(result).toBe('retry');
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining('Network unreachable'),
      expect.any(String),
    );
    const callArgs = selectMock.mock.calls[0]![0]!;
    expect(callArgs.options).toHaveLength(3);
    expect(callArgs.options.map((o: { value: string }) => o.value)).toEqual(['retry', 'continue-lite', 'quit']);
  });

  // AC: disk-full → message with space info + p.select
  it('shows disk-full note with space info', async () => {
    selectMock.mockResolvedValueOnce('continue-lite');
    const result = await promptDownloadRecovery({
      ...baseOpts('disk-full'),
      neededGB: 15,
    });
    expect(result).toBe('continue-lite');
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining('~15 GB'),
      expect.any(String),
    );
  });

  // AC: docker error → note + select with 3 options
  it('shows docker error note and select', async () => {
    selectMock.mockResolvedValueOnce('retry');
    const result = await promptDownloadRecovery(baseOpts('docker'));
    expect(result).toBe('retry');
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining('Docker daemon not running'),
      expect.any(String),
    );
  });

  // AC: SHA mismatch → p.confirm for re-download
  it('shows confirm for sha-mismatch and returns retry on yes', async () => {
    confirmMock.mockResolvedValueOnce(true);
    const result = await promptDownloadRecovery(baseOpts('sha-mismatch'));
    expect(result).toBe('retry');
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Re-download') }),
    );
  });

  it('returns continue-lite for sha-mismatch when user declines', async () => {
    confirmMock.mockResolvedValueOnce(false);
    const result = await promptDownloadRecovery(baseOpts('sha-mismatch'));
    expect(result).toBe('continue-lite');
  });

  // AC: Ctrl+C on select → quit
  it('returns quit when user cancels select', async () => {
    selectMock.mockResolvedValueOnce(Symbol('cancel') as unknown as string);
    const result = await promptDownloadRecovery(baseOpts('network'));
    expect(result).toBe('quit');
  });

  // AC: Ctrl+C on confirm → quit
  it('returns quit when user cancels confirm', async () => {
    confirmMock.mockResolvedValueOnce(Symbol('cancel') as unknown as boolean);
    const result = await promptDownloadRecovery(baseOpts('sha-mismatch'));
    expect(result).toBe('quit');
  });

  // unknown errors → treated like network (generic recovery)
  it('shows generic note for unknown errors', async () => {
    selectMock.mockResolvedValueOnce('quit');
    const result = await promptDownloadRecovery(baseOpts('unknown'));
    expect(result).toBe('quit');
    expect(noteMock).toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalled();
  });
});
