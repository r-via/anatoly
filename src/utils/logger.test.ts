import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLogger,
  initLogger,
  getLogger,
  resolveLogLevel,
  _resetLogger,
  LOG_LEVELS,
} from './logger.js';

describe('resolveLogLevel', () => {
  const origEnv = process.env['ANATOLY_LOG_LEVEL'];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['ANATOLY_LOG_LEVEL'];
    } else {
      process.env['ANATOLY_LOG_LEVEL'] = origEnv;
    }
  });

  it('should default to warn when no options provided', () => {
    delete process.env['ANATOLY_LOG_LEVEL'];
    expect(resolveLogLevel({})).toBe('warn');
  });

  it('should use --log-level when provided', () => {
    expect(resolveLogLevel({ logLevel: 'trace' })).toBe('trace');
  });

  it('should map --verbose to debug', () => {
    expect(resolveLogLevel({ verbose: true })).toBe('debug');
  });

  it('should give --log-level priority over --verbose', () => {
    expect(resolveLogLevel({ logLevel: 'info', verbose: true })).toBe('info');
  });

  it('should use ANATOLY_LOG_LEVEL env var as fallback', () => {
    process.env['ANATOLY_LOG_LEVEL'] = 'trace';
    expect(resolveLogLevel({})).toBe('trace');
  });

  it('should give --log-level priority over env var', () => {
    process.env['ANATOLY_LOG_LEVEL'] = 'trace';
    expect(resolveLogLevel({ logLevel: 'error' })).toBe('error');
  });

  it('should ignore invalid env var values', () => {
    process.env['ANATOLY_LOG_LEVEL'] = 'bogus';
    expect(resolveLogLevel({})).toBe('warn');
  });

  it('should ignore invalid --log-level values', () => {
    expect(resolveLogLevel({ logLevel: 'bogus' })).toBe('warn');
  });
});

describe('LOG_LEVELS', () => {
  it('should contain all six pino levels', () => {
    expect(LOG_LEVELS).toEqual(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
  });
});

describe('createLogger', () => {
  it('should create a logger with default warn level', () => {
    const logger = createLogger({ pretty: false });
    expect(logger.level).toBe('warn');
  });

  it('should create a logger at the requested level', () => {
    const logger = createLogger({ level: 'debug', pretty: false });
    expect(logger.level).toBe('debug');
  });

  it('should add component field when namespace is provided', () => {
    const logger = createLogger({ namespace: 'scanner', pretty: false });
    // Child loggers store bindings — verify through the bindings method
    const bindings = logger.bindings();
    expect(bindings.component).toBe('scanner');
  });
});

describe('initLogger / getLogger singleton', () => {
  beforeEach(() => {
    _resetLogger();
  });

  afterEach(() => {
    _resetLogger();
  });

  it('should create singleton accessible via getLogger()', () => {
    const logger = initLogger({ level: 'debug', pretty: false });
    expect(getLogger()).toBe(logger);
  });

  it('should return existing instance on double init and warn', () => {
    const first = initLogger({ level: 'debug', pretty: false });
    const warnSpy = vi.spyOn(first, 'warn');
    const second = initLogger({ level: 'trace', pretty: false });
    expect(second).toBe(first);
    expect(warnSpy).toHaveBeenCalledWith(
      'initLogger() called more than once — returning existing instance',
    );
    warnSpy.mockRestore();
  });

  it('should lazily create default logger via getLogger()', () => {
    const logger = getLogger();
    expect(logger).toBeDefined();
    expect(logger.level).toBe('warn');
  });
});
