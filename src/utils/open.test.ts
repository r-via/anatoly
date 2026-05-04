// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:os', () => ({
  platform: vi.fn(),
}));

describe('openFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('should use xdg-open on linux', async () => {
    vi.mocked(platform).mockReturnValue('linux');
    vi.mocked(execFile).mockImplementation((() => {}) as never);

    const { openFile } = await import('./open.js');
    openFile('/tmp/report.md');

    expect(execFile).toHaveBeenCalledWith('xdg-open', ['/tmp/report.md'], expect.any(Function));
  });

  it('should use open on macOS', async () => {
    vi.mocked(platform).mockReturnValue('darwin');
    vi.mocked(execFile).mockImplementation((() => {}) as never);

    const { openFile } = await import('./open.js');
    openFile('/tmp/report.md');

    expect(execFile).toHaveBeenCalledWith('open', ['/tmp/report.md'], expect.any(Function));
  });

  it('should use cmd /c start on Windows', async () => {
    vi.mocked(platform).mockReturnValue('win32');
    vi.mocked(execFile).mockImplementation((() => {}) as never);

    const { openFile } = await import('./open.js');
    openFile('C:\\tmp\\report.md');

    expect(execFile).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'C:\\tmp\\report.md'], expect.any(Function));
  });

  it('should log error on failure without throwing', async () => {
    vi.mocked(platform).mockReturnValue('linux');
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: (...args: unknown[]) => unknown) => {
      if (typeof cb === 'function') cb(new Error('not found'), '', '');
    }) as never);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { openFile } = await import('./open.js');
    openFile('/tmp/report.md');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('could not open report'));
    stderrSpy.mockRestore();
  });
});

describe('tryOpenFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('resolves true when execFile succeeds', async () => {
    vi.mocked(platform).mockReturnValue('linux');
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: (...args: unknown[]) => unknown) => {
      if (typeof cb === 'function') cb(null, '', '');
    }) as never);

    const { tryOpenFile } = await import('./open.js');
    await expect(tryOpenFile('/tmp/config.yml')).resolves.toBe(true);
    expect(execFile).toHaveBeenCalledWith('xdg-open', ['/tmp/config.yml'], expect.any(Function));
  });

  it('resolves false when execFile fails', async () => {
    vi.mocked(platform).mockReturnValue('linux');
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: (...args: unknown[]) => unknown) => {
      if (typeof cb === 'function') cb(new Error('no editor'), '', '');
    }) as never);

    const { tryOpenFile } = await import('./open.js');
    await expect(tryOpenFile('/tmp/config.yml')).resolves.toBe(false);
  });

  it('uses platform-specific command', async () => {
    vi.mocked(platform).mockReturnValue('darwin');
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: (...args: unknown[]) => unknown) => {
      if (typeof cb === 'function') cb(null, '', '');
    }) as never);

    const { tryOpenFile } = await import('./open.js');
    await tryOpenFile('/tmp/config.yml');
    expect(execFile).toHaveBeenCalledWith('open', ['/tmp/config.yml'], expect.any(Function));
  });
});
