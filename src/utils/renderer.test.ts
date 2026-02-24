import { describe, it, expect } from 'vitest';
import { createRenderer } from './renderer.js';

describe('createRenderer (plain mode)', () => {
  it('should create a plain renderer with all methods', () => {
    const renderer = createRenderer({ plain: true, version: '1.0.0' });
    expect(renderer).toBeDefined();
    expect(renderer.start).toBeTypeOf('function');
    expect(renderer.updateProgress).toBeTypeOf('function');
    expect(renderer.addResult).toBeTypeOf('function');
    expect(renderer.incrementCounter).toBeTypeOf('function');
    expect(renderer.showCompletion).toBeTypeOf('function');
    expect(renderer.stop).toBeTypeOf('function');
    expect(renderer.updateWorkerSlot).toBeTypeOf('function');
    expect(renderer.clearWorkerSlot).toBeTypeOf('function');
  });

  it('should handle worker slot methods without error in plain mode', () => {
    const renderer = createRenderer({ plain: true, version: '1.0.0' });
    // These should be no-ops and not throw
    renderer.updateWorkerSlot(0, 'src/foo.ts');
    renderer.clearWorkerSlot(0);
  });
});
