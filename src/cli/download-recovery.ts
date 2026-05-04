// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import * as p from '@clack/prompts';
import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DownloadErrorKind = 'network' | 'disk-full' | 'docker' | 'sha-mismatch' | 'unknown';
export type RecoveryChoice = 'retry' | 'continue-lite' | 'quit';

export interface RecoveryOptions {
  kind: DownloadErrorKind;
  error: Error;
  isTTY: boolean;
  defaultsSettings: boolean;
  /** Approximate disk space needed in GB (shown in disk-full messages). */
  neededGB?: number;
  /** Directory to check for free space (defaults to ~/.anatoly/models). */
  modelDir?: string;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'ENOTFOUND']);

/**
 * Classify a download error into a known category for recovery prompts.
 */
export function classifyDownloadError(err: Error): DownloadErrorKind {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC') return 'disk-full';
  if (code && NETWORK_CODES.has(code)) return 'network';

  const msg = err.message.toLowerCase();
  if (msg.includes('fetch failed') || msg.includes('network')) return 'network';
  if (msg.includes('sha-256') || msg.includes('sha256') || msg.includes('mismatch') || msg.includes('corrupt')) return 'sha-mismatch';
  if (msg.includes('docker') || msg.includes('daemon')) return 'docker';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Disk space helper
// ---------------------------------------------------------------------------

function getFreeDiskGB(dir: string): number | undefined {
  try {
    const stats = statfsSync(dir);
    return Math.round((stats.bavail * stats.bsize) / (1024 ** 3));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Recovery prompt
// ---------------------------------------------------------------------------

/**
 * Show a recovery prompt for a download failure. Returns the user's choice.
 *
 * In non-interactive mode (`--defaults-settings` or non-TTY), auto-falls-back
 * to `'continue-lite'` with a warning log.
 */
export async function promptDownloadRecovery(opts: RecoveryOptions): Promise<RecoveryChoice> {
  const log = getLogger();

  // Non-interactive: auto-fallback
  if (opts.defaultsSettings || !opts.isTTY) {
    log.warn({ err: opts.error.message, kind: opts.kind }, 'download failed — auto-fallback to lite mode');
    return 'continue-lite';
  }

  // SHA mismatch: special confirm flow
  if (opts.kind === 'sha-mismatch') {
    p.note('File corrupt. The downloaded file failed integrity verification.', 'Download error');
    const redownload = await p.confirm({
      message: 'File corrupt. Re-download?',
      initialValue: true,
    });
    if (p.isCancel(redownload)) return 'quit';
    return redownload ? 'retry' : 'continue-lite';
  }

  // Build message based on error kind
  let noteMessage: string;
  switch (opts.kind) {
    case 'network':
      noteMessage = "Network unreachable. Anatoly couldn't download embedding models.";
      break;
    case 'disk-full': {
      const needed = opts.neededGB ?? 15;
      const dir = opts.modelDir ?? resolve(homedir(), '.anatoly', 'models');
      const freeGB = getFreeDiskGB(dir);
      noteMessage = freeGB !== undefined
        ? `Need ~${needed} GB in ~/.anatoly/models \u2014 currently ${freeGB} GB free`
        : `Need ~${needed} GB in ~/.anatoly/models \u2014 disk appears full`;
      break;
    }
    case 'docker':
      noteMessage = 'Docker daemon not running. Try: sudo systemctl start docker';
      break;
    default:
      noteMessage = `Download failed: ${opts.error.message}`;
      break;
  }

  p.note(noteMessage, 'Download error');

  // Recovery select
  type ChoiceValue = RecoveryChoice;
  const retryLabel = opts.kind === 'disk-full' ? 'I freed space \u2014 retry' : 'Retry download';
  const choice = await p.select({
    message: 'How would you like to proceed?',
    options: [
      { value: 'retry' as ChoiceValue, label: retryLabel },
      { value: 'continue-lite' as ChoiceValue, label: 'Continue in lite mode (skip advanced)' },
      { value: 'quit' as ChoiceValue, label: 'Quit' },
    ],
  });

  if (p.isCancel(choice)) return 'quit';
  return choice as RecoveryChoice;
}
