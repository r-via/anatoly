// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * ndjson-tail — Story 53.5
 *
 * Tails an ndjson file, emitting parsed events as they are appended.
 * Supports both `fromStart` (replay + tail) and tail-only modes.
 * Handles partial lines gracefully.
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';

export interface TailNdjsonOptions {
  /** If true, read from beginning of file; if false, start from current end. */
  fromStart: boolean;
  /** Called for each successfully parsed JSON event. */
  onEvent: (event: unknown) => void;
  /** Called when a line cannot be parsed as JSON. */
  onError: (err: Error) => void;
}

export interface TailHandle {
  /** Stop watching the file and clean up resources. */
  stop: () => void;
}

/**
 * Tail an ndjson file, emitting parsed JSON objects as they are appended.
 *
 * - `fromStart: true` reads all existing content then watches for new lines.
 * - `fromStart: false` skips to end of file and watches for new lines only.
 * - Handles partial lines (data without trailing newline) by buffering.
 * - Handles files that don't exist yet (polls until created).
 */
export function tailNdjson(filePath: string, opts: TailNdjsonOptions): TailHandle {
  let stopped = false;
  let offset = 0;
  let buffer = '';
  let watcher: FSWatcher | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  function processNewData(): void {
    if (stopped) return;

    if (!existsSync(filePath)) return;

    let fileSize: number;
    try {
      fileSize = statSync(filePath).size;
    } catch {
      return;
    }

    if (fileSize <= offset) return;

    // Read new bytes
    let newData: string;
    try {
      const fullContent = readFileSync(filePath, 'utf-8');
      newData = fullContent.slice(offset);
      offset = fullContent.length;
    } catch {
      return;
    }

    buffer += newData;

    // Process complete lines
    const lines = buffer.split('\n');
    // Last element is either '' (if data ended with \n) or a partial line
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (stopped) return;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        opts.onEvent(parsed);
      } catch {
        opts.onError(new Error(`Failed to parse ndjson line: ${trimmed}`));
      }
    }
  }

  function init(): void {
    // Set initial offset
    if (!opts.fromStart && existsSync(filePath)) {
      try {
        offset = statSync(filePath).size;
      } catch {
        offset = 0;
      }
    }

    // Read existing content if fromStart
    processNewData();

    // Try fs.watch for efficiency, fall back to polling
    try {
      if (existsSync(filePath)) {
        watcher = watch(filePath, () => processNewData());
      }
    } catch {
      // fs.watch not available, will use polling
    }

    // Always poll as fallback (handles file-not-yet-created and fs.watch gaps)
    pollTimer = setInterval(() => {
      if (stopped) return;

      // If file didn't exist before but now does, start watching
      if (!watcher && existsSync(filePath)) {
        try {
          watcher = watch(filePath, () => processNewData());
        } catch {
          // continue polling
        }
      }

      processNewData();
    }, 100);
  }

  init();

  return {
    stop() {
      stopped = true;
      if (watcher) {
        watcher.close();
        watcher = undefined;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
  };
}
