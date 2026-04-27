// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Desktop Notification — Story 47.5
 *
 * Sends OS-level desktop notifications when a background review completes.
 * Uses `notify-send` on Linux and `osascript` on macOS.
 * Silently ignored if the notification tool is unavailable.
 */

import { execFileSync } from 'node:child_process';

/**
 * Send a desktop notification with the given title and body.
 * Silently ignores errors (tool not installed, unsupported platform, etc.).
 */
export function sendDesktopNotification(title: string, body: string): void {
  try {
    const platform = process.platform;

    if (platform === 'linux') {
      execFileSync('notify-send', [title, body], { stdio: 'ignore', timeout: 5000 });
    } else if (platform === 'darwin') {
      const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`;
      execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 5000 });
    }
    // Other platforms (win32, etc.) — silently skip
  } catch {
    // Silently ignore: tool not installed, permission denied, etc.
  }
}

/** Escape double-quotes and backslashes for AppleScript string literals. */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
