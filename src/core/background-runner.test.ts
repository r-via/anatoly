// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { buildForwardedArgs, launchBackgroundRun } from './background-runner.js';
import { readRunStatus } from './run-status.js';

// Mock child_process.spawn to avoid actually spawning processes in tests
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');

  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = 99999;
      child.unref = vi.fn();
      return child;
    }),
  };
});

// Mock createWriteStream to avoid async file handle errors in tests
const mockWriteStream = new Writable({ write(_chunk, _enc, cb) { cb(); } });
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    createWriteStream: vi.fn(() => mockWriteStream),
  };
});

describe('background-runner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-bg-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('launchBackgroundRun', () => {
    it('should write run-status.json with status=running', () => {
      const runDir = join(tempDir, '.anatoly', 'runs', 'bg-run-1');

      const result = launchBackgroundRun(tempDir, 'bg-run-1', runDir, []);

      expect(result.runId).toBe('bg-run-1');
      expect(result.pid).toBe(99999);

      const status = readRunStatus(runDir);
      expect(status).toBeDefined();
      expect(status!.runId).toBe('bg-run-1');
      expect(status!.status).toBe('running');
      expect(status!.pid).toBe(99999);
      expect(status!.background).toBe(true);
      expect(status!.startedAt).toBeTruthy();
    });

    it('should create a write stream for background.log', async () => {
      const { createWriteStream } = await import('node:fs');
      const runDir = join(tempDir, '.anatoly', 'runs', 'bg-run-2');

      launchBackgroundRun(tempDir, 'bg-run-2', runDir, []);

      expect(createWriteStream).toHaveBeenCalledWith(
        join(runDir, 'background.log'),
        { flags: 'a' },
      );
    });

    it('should forward additional CLI args to child process', async () => {
      const { spawn } = await import('node:child_process');
      const runDir = join(tempDir, '.anatoly', 'runs', 'bg-run-3');

      launchBackgroundRun(tempDir, 'bg-run-3', runDir, ['--no-cache', '--axes', 'utility']);

      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining(['run', '--run-id', 'bg-run-3', '--no-cache', '--axes', 'utility']),
        expect.objectContaining({
          detached: true,
          env: expect.objectContaining({ ANATOLY_BACKGROUND_MODE: '1' }),
        }),
      );
    });

    it('should set detached=true and call unref on child', async () => {
      const { spawn } = await import('node:child_process');
      const runDir = join(tempDir, '.anatoly', 'runs', 'bg-run-4');

      launchBackgroundRun(tempDir, 'bg-run-4', runDir, []);

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ detached: true }),
      );
      // Check unref was called (child mock)
      const child = (spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(child.unref).toHaveBeenCalled();
    });
  });

  describe('buildForwardedArgs', () => {
    it('should return empty array for default options', () => {
      expect(buildForwardedArgs({})).toEqual([]);
    });

    it('should forward --axes option', () => {
      const args = buildForwardedArgs({ axes: 'utility,correction' });
      expect(args).toEqual(['--axes', 'utility,correction']);
    });

    it('should forward --no-cache when cache is false', () => {
      const args = buildForwardedArgs({ cache: false });
      expect(args).toEqual(['--no-cache']);
    });

    it('should forward --file option', () => {
      const args = buildForwardedArgs({ file: 'src/**/*.ts' });
      expect(args).toEqual(['--file', 'src/**/*.ts']);
    });

    it('should forward --concurrency option', () => {
      const args = buildForwardedArgs({ concurrency: 5 });
      expect(args).toEqual(['--concurrency', '5']);
    });

    it('should forward multiple options', () => {
      const args = buildForwardedArgs({
        axes: 'utility',
        cache: false,
        concurrency: 3,
        rebuildRag: true,
      });
      expect(args).toContain('--axes');
      expect(args).toContain('--no-cache');
      expect(args).toContain('--concurrency');
      expect(args).toContain('--rebuild-rag');
    });

    it('should forward deliberation flags correctly', () => {
      expect(buildForwardedArgs({ deliberation: true })).toEqual(['--deliberation']);
      expect(buildForwardedArgs({ deliberation: false })).toEqual(['--no-deliberation']);
    });

    it('should not forward undefined/null values', () => {
      const args = buildForwardedArgs({
        axes: undefined,
        file: undefined,
        concurrency: undefined,
      });
      expect(args).toEqual([]);
    });

    it('should forward --no-notify when notify is false', () => {
      const args = buildForwardedArgs({ notify: false });
      expect(args).toEqual(['--no-notify']);
    });

    it('should not forward --no-notify when notify is true or undefined', () => {
      expect(buildForwardedArgs({ notify: true })).toEqual([]);
      expect(buildForwardedArgs({ notify: undefined })).toEqual([]);
    });
  });
});
