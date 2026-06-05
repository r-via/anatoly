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

/**
 * Escape a string for embedding inside an AppleScript double-quoted literal
 * (modern macOS osascript supports the `\\`, `\"`, `\n`, `\r`, `\t` escapes).
 * Backslash is escaped first so the escapes inserted afterwards are not
 * re-doubled. Newlines/carriage returns MUST be escaped: a literal newline
 * inside a double-quoted AppleScript string is a parse error, which made
 * osascript exit non-zero and silently drop any multi-line notification body.
 */
export function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
