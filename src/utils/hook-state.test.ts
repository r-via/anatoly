import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadHookState, saveHookState, initHookState, isProcessRunning } from './hook-state.js';

const TEST_ROOT = resolve(__dirname, '../../.test-hook-state');
const ANATOLY_DIR = resolve(TEST_ROOT, '.anatoly');

describe('hook-state', () => {
  beforeEach(() => {
    mkdirSync(ANATOLY_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  describe('initHookState', () => {
    it('creates a fresh state with session_id, stop_count 0, empty reviews', () => {
      const state = initHookState();
      expect(state.session_id).toMatch(/^hook-\d+-[a-z0-9]+$/);
      expect(state.stop_count).toBe(0);
      expect(state.reviews).toEqual({});
    });
  });

  describe('loadHookState', () => {
    it('returns fresh state when no file exists', () => {
      const state = loadHookState(TEST_ROOT);
      expect(state.session_id).toBeTruthy();
      expect(state.stop_count).toBe(0);
      expect(state.reviews).toEqual({});
    });

    it('returns fresh state when file is corrupted', () => {
      writeFileSync(resolve(ANATOLY_DIR, 'hook-state.json'), 'invalid json');
      const state = loadHookState(TEST_ROOT);
      expect(state.session_id).toBeTruthy();
      expect(state.reviews).toEqual({});
    });

    it('loads valid state from disk', () => {
      const savedState = {
        session_id: 'hook-123-abc',
        stop_count: 2,
        reviews: {
          'src/foo.ts': {
            pid: 99999999, // Non-existent PID
            status: 'done',
            started_at: '2026-01-01T00:00:00.000Z',
            rev_path: '/tmp/foo.rev.json',
          },
        },
      };
      writeFileSync(resolve(ANATOLY_DIR, 'hook-state.json'), JSON.stringify(savedState));
      const state = loadHookState(TEST_ROOT);
      expect(state.session_id).toBe('hook-123-abc');
      expect(state.stop_count).toBe(2);
      expect(state.reviews['src/foo.ts'].status).toBe('done');
    });

    it('marks running reviews with dead PIDs as error (orphan detection)', () => {
      const savedState = {
        session_id: 'hook-123-abc',
        stop_count: 0,
        reviews: {
          'src/bar.ts': {
            pid: 99999999, // Non-existent PID
            status: 'running',
            started_at: '2026-01-01T00:00:00.000Z',
            rev_path: '/tmp/bar.rev.json',
          },
        },
      };
      writeFileSync(resolve(ANATOLY_DIR, 'hook-state.json'), JSON.stringify(savedState));
      const state = loadHookState(TEST_ROOT);
      expect(state.reviews['src/bar.ts'].status).toBe('error');
    });

    it('returns fresh state when session_id is missing', () => {
      const savedState = { stop_count: 0, reviews: {} };
      writeFileSync(resolve(ANATOLY_DIR, 'hook-state.json'), JSON.stringify(savedState));
      const state = loadHookState(TEST_ROOT);
      expect(state.session_id).toBeTruthy();
      expect(state.session_id).not.toBe('');
    });
  });

  describe('saveHookState', () => {
    it('writes state to disk atomically', () => {
      const state = initHookState();
      state.reviews['src/test.ts'] = {
        pid: 12345,
        status: 'running',
        started_at: new Date().toISOString(),
        rev_path: '/tmp/test.rev.json',
      };

      saveHookState(TEST_ROOT, state);

      const path = resolve(ANATOLY_DIR, 'hook-state.json');
      expect(existsSync(path)).toBe(true);

      const loaded = JSON.parse(readFileSync(path, 'utf-8'));
      expect(loaded.session_id).toBe(state.session_id);
      expect(loaded.reviews['src/test.ts'].pid).toBe(12345);
    });

    it('creates .anatoly directory if it does not exist', () => {
      rmSync(ANATOLY_DIR, { recursive: true, force: true });

      const state = initHookState();
      saveHookState(TEST_ROOT, state);

      expect(existsSync(resolve(ANATOLY_DIR, 'hook-state.json'))).toBe(true);
    });
  });

  describe('isProcessRunning', () => {
    it('returns true for the current process', () => {
      expect(isProcessRunning(process.pid)).toBe(true);
    });

    it('returns false for a non-existent PID', () => {
      expect(isProcessRunning(99999999)).toBe(false);
    });

    it('returns false for PID 0', () => {
      expect(isProcessRunning(0)).toBe(false);
    });

    it('returns false for negative PID', () => {
      expect(isProcessRunning(-1)).toBe(false);
    });
  });
});
