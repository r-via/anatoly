import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runWithContext, getLogContext, contextLogger } from './log-context.js';
import { _resetLogger, initLogger } from './logger.js';

describe('runWithContext / getLogContext', () => {
  it('should return undefined outside of any context', () => {
    expect(getLogContext()).toBeUndefined();
  });

  it('should provide context inside runWithContext', () => {
    runWithContext({ runId: 'abc-123' }, () => {
      expect(getLogContext()).toEqual({ runId: 'abc-123' });
    });
  });

  it('should merge nested contexts (child overwrites parent)', () => {
    runWithContext({ runId: 'abc', phase: 'scan' }, () => {
      runWithContext({ file: 'src/foo.ts', phase: 'review' }, () => {
        expect(getLogContext()).toEqual({
          runId: 'abc',
          file: 'src/foo.ts',
          phase: 'review', // child overrides parent
        });
      });
      // outer context is restored
      expect(getLogContext()).toEqual({ runId: 'abc', phase: 'scan' });
    });
  });

  it('should support triple nesting (run > file > axis)', () => {
    runWithContext({ runId: 'r1', phase: 'review' }, () => {
      runWithContext({ file: 'src/bar.ts', worker: 2 }, () => {
        runWithContext({ axis: 'utility' }, () => {
          expect(getLogContext()).toEqual({
            runId: 'r1',
            phase: 'review',
            file: 'src/bar.ts',
            worker: 2,
            axis: 'utility',
          });
        });
      });
    });
  });

  it('should isolate context between concurrent workers', async () => {
    const results: Array<{ worker: number; ctx: ReturnType<typeof getLogContext> }> = [];

    await Promise.all([
      runWithContext({ runId: 'r1', worker: 0 }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push({ worker: 0, ctx: getLogContext() });
      }),
      runWithContext({ runId: 'r1', worker: 1 }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push({ worker: 1, ctx: getLogContext() });
      }),
    ]);

    const w0 = results.find((r) => r.worker === 0);
    const w1 = results.find((r) => r.worker === 1);
    expect(w0?.ctx?.worker).toBe(0);
    expect(w1?.ctx?.worker).toBe(1);
  });

  it('should return a sync value from the callback', () => {
    const result = runWithContext({ runId: 'x' }, () => 42);
    expect(result).toBe(42);
  });
});

describe('contextLogger', () => {
  beforeEach(() => {
    _resetLogger();
    initLogger({ level: 'debug', pretty: false });
  });

  it('should return base logger when no context is active', () => {
    const logger = contextLogger();
    // No extra bindings beyond the base logger
    expect(logger.bindings()).toEqual({});
  });

  it('should include context fields in child logger bindings', () => {
    runWithContext({ runId: 'r1', phase: 'scan' }, () => {
      const logger = contextLogger();
      const b = logger.bindings();
      expect(b.runId).toBe('r1');
      expect(b.phase).toBe('scan');
    });
  });

  it('should include namespace as component', () => {
    const logger = contextLogger('scanner');
    expect(logger.bindings().component).toBe('scanner');
  });

  it('should merge context + namespace', () => {
    runWithContext({ runId: 'r1', file: 'src/a.ts' }, () => {
      const logger = contextLogger('axis-evaluator');
      const b = logger.bindings();
      expect(b.runId).toBe('r1');
      expect(b.file).toBe('src/a.ts');
      expect(b.component).toBe('axis-evaluator');
    });
  });

  afterEach(() => {
    _resetLogger();
  });
});
