// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { sendDesktopNotification } from './desktop.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('desktop notifications', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  describe('sendDesktopNotification', () => {
    it('should call notify-send on Linux', () => {
      setPlatform('linux');
      sendDesktopNotification('Anatoly', 'Review complete — 5 findings in 12 files');

      expect(childProcess.execFileSync).toHaveBeenCalledWith(
        'notify-send',
        ['Anatoly', 'Review complete — 5 findings in 12 files'],
        expect.objectContaining({ stdio: 'ignore' }),
      );
    });

    it('should call osascript on macOS', () => {
      setPlatform('darwin');
      sendDesktopNotification('Anatoly', 'Review complete — 3 findings in 8 files');

      expect(childProcess.execFileSync).toHaveBeenCalledWith(
        'osascript',
        ['-e', expect.stringContaining('Review complete — 3 findings in 8 files')],
        expect.objectContaining({ stdio: 'ignore' }),
      );
    });

    it('should silently ignore when notification tool is not available', () => {
      setPlatform('linux');
      vi.mocked(childProcess.execFileSync).mockImplementation(() => {
        throw new Error('spawn notify-send ENOENT');
      });

      // Should not throw
      expect(() => sendDesktopNotification('Anatoly', 'test')).not.toThrow();
    });

    it('should silently ignore on unsupported platforms', () => {
      setPlatform('win32');
      sendDesktopNotification('Anatoly', 'test');

      // No exec call should be made on unsupported platforms
      expect(childProcess.execFileSync).not.toHaveBeenCalled();
    });

    it('should include error message for failed runs', () => {
      setPlatform('linux');
      sendDesktopNotification('Anatoly', 'Review failed: Rate limit exceeded');

      expect(childProcess.execFileSync).toHaveBeenCalledWith(
        'notify-send',
        ['Anatoly', 'Review failed: Rate limit exceeded'],
        expect.objectContaining({ stdio: 'ignore' }),
      );
    });
  });
});
