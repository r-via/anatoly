// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

export interface LoggerOptions {
  level?: LogLevel;
  logFile?: string;
  pretty?: boolean;
  namespace?: string;
}

export type Logger = pino.Logger;

// ---------------------------------------------------------------------------
// Resolve effective log level from CLI flags / env
// ---------------------------------------------------------------------------

/**
 * Determine the log level to use.
 * Priority: explicit `--log-level` > `--verbose` flag > `ANATOLY_LOG_LEVEL` env > default.
 *
 * Invalid values for `logLevel` or `ANATOLY_LOG_LEVEL` are silently ignored
 * and fall back to `'warn'`. The CLI validates `--log-level` before calling
 * this function, so the silent fallback only applies to programmatic callers.
 */
export function resolveLogLevel(opts: {
  logLevel?: string;
  verbose?: boolean;
}): LogLevel {
  if (opts.logLevel && LOG_LEVELS.includes(opts.logLevel as LogLevel)) {
    return opts.logLevel as LogLevel;
  }
  if (opts.verbose) return 'debug';
  const env = process.env['ANATOLY_LOG_LEVEL'];
  if (env && LOG_LEVELS.includes(env as LogLevel)) return env as LogLevel;
  return 'warn';
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

/**
 * Create a pino logger instance. This is the low-level factory — most callers
 * should use {@link getLogger} (the singleton) or {@link initLogger} to set it up.
 *
 * Configures up to two transport targets:
 * - **stderr**: uses `pino-pretty` when the terminal is a TTY (or `pretty` is
 *   explicitly set), otherwise plain ndjson. Filtered at the requested level.
 * - **log file** (when `logFile` is provided): always captures `debug`+ to an
 *   ndjson file. The pino instance level is lowered to `debug` so records are
 *   not dropped before reaching this target.
 *
 * When `namespace` is provided the returned logger is a child logger with
 * `{ component: namespace }` bound to every record.
 *
 * @param options - Logger configuration (level, file path, pretty-print, namespace).
 * @returns A configured pino {@link Logger} instance.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'warn';
  const targets: pino.TransportTargetOptions[] = [];

  if (options.pretty ?? process.stderr.isTTY) {
    targets.push({
      target: 'pino-pretty',
      options: { destination: 2 },
      level,
    });
  } else {
    targets.push({
      target: 'pino/file',
      options: { destination: 2 },
      level,
    });
  }

  if (options.logFile) {
    targets.push({
      target: 'pino/file',
      options: { destination: options.logFile, mkdir: true },
      level: 'debug', // file always captures debug+
    });
  }

  const transport = pino.transport({ targets });

  // The pino instance level gates all transports — set it to the least
  // restrictive level across all targets so no transport is starved.
  const instanceLevel: LogLevel = options.logFile
    ? (LOG_LEVELS.indexOf(level) > LOG_LEVELS.indexOf('debug') ? level : 'debug')
    : level;

  const logger = pino({ level: instanceLevel }, transport);

  if (options.namespace) {
    return logger.child({ component: options.namespace });
  }
  return logger;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: Logger | undefined;
let _fileDestination: pino.DestinationStream | undefined;

/**
 * Initialise the global logger singleton. Should be called once during CLI
 * startup. Subsequent calls emit a warning and return the existing instance.
 *
 * @param options - Logger configuration forwarded to {@link createLogger}.
 * @returns The global {@link Logger} singleton.
 */
export function initLogger(options: LoggerOptions = {}): Logger {
  if (_instance) {
    _instance.warn('initLogger() called more than once — returning existing instance');
    return _instance;
  }
  _instance = createLogger(options);
  return _instance;
}

/**
 * Return the global logger singleton. If `initLogger()` has not been called
 * yet, a default warn-level logger is created lazily.
 */
export function getLogger(): Logger {
  if (!_instance) {
    _instance = createLogger();
  }
  return _instance;
}

/**
 * Create a standalone file logger that writes ndjson to a specific path.
 * Used for per-run log files (e.g. `.anatoly/runs/<runId>/anatoly.ndjson`).
 * Always writes at debug level regardless of the console logger's level.
 *
 * **Side-effect:** caches the underlying destination stream in a module-level
 * variable so {@link flushFileLogger} can synchronously flush it on exit.
 * Calling this function again replaces the cached destination.
 *
 * @param filePath - Absolute path for the ndjson log file. Parent directories
 *   are created automatically.
 * @returns A pino {@link Logger} writing at `debug` level to `filePath`.
 */
export function createFileLogger(filePath: string): Logger {
  mkdirSync(dirname(filePath), { recursive: true });
  _fileDestination = pino.destination({ dest: filePath, sync: true });
  return pino({ level: 'debug' }, _fileDestination);
}

/**
 * Flush the per-run file logger synchronously. Call on SIGINT / process exit
 * to avoid losing buffered log entries.
 */
export function flushFileLogger(): void {
  if (_fileDestination && 'flushSync' in _fileDestination) {
    (_fileDestination as pino.DestinationStream & { flushSync: () => void }).flushSync();
  }
}

/**
 * Reset the singleton — only for testing.
 * @internal
 */
export function _resetLogger(): void {
  _instance = undefined;
  _fileDestination = undefined;
}
