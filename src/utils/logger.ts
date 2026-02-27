import pino from 'pino';

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
 * should use `getLogger()` (the singleton) or `initLogger()` to set it up.
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

  const logger = pino({ level }, transport);

  if (options.namespace) {
    return logger.child({ component: options.namespace });
  }
  return logger;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: Logger | undefined;

/**
 * Initialise the global logger singleton. Should be called once during CLI
 * startup. Subsequent calls emit a warning and return the existing instance.
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
 * Reset the singleton — only for testing.
 * @internal
 */
export function _resetLogger(): void {
  _instance = undefined;
}
