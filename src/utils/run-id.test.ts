// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateRunId,
  isValidRunId,
  createRunDir,
  createMiniRun,
  resolveRunDir,
  listRuns,
  purgeRuns,
} from './run-id.js';

describe('run-id', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'run-id-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('generateRunId', () => {
    it('should return a timestamp-formatted string', () => {
      const id = generateRunId();
      expect(id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}$/);
    });

    it('should return prefixed run ID when prefix is given', () => {
      const id = generateRunId('scan');
      expect(id).toMatch(/^scan-\d{4}-\d{2}-\d{2}_\d{6}$/);
    });

    it('should support arbitrary prefixes', () => {
      const id = generateRunId('estimate');
      expect(id).toMatch(/^estimate-\d{4}-\d{2}-\d{2}_\d{6}$/);
    });
  });

  describe('isValidRunId', () => {
    it('should accept alphanumeric with dashes and underscores', () => {
      expect(isValidRunId('pre-refactor')).toBe(true);
      expect(isValidRunId('2026-02-24_143000')).toBe(true);
      expect(isValidRunId('my_run_1')).toBe(true);
    });

    it('should reject empty strings', () => {
      expect(isValidRunId('')).toBe(false);
    });

    it('should reject path traversal characters', () => {
      expect(isValidRunId('../etc')).toBe(false);
      expect(isValidRunId('foo/bar')).toBe(false);
      expect(isValidRunId('foo bar')).toBe(false);
    });

    it('should reject strings longer than 64 characters', () => {
      expect(isValidRunId('a'.repeat(65))).toBe(false);
      expect(isValidRunId('a'.repeat(64))).toBe(true);
    });
  });

  describe('createRunDir', () => {
    it('should create logs/, reviews/, and conversations/ subdirectories', () => {
      const runDir = createRunDir(tmpDir, 'test-run');
      expect(existsSync(join(runDir, 'logs'))).toBe(true);
      expect(existsSync(join(runDir, 'reviews'))).toBe(true);
      expect(existsSync(join(runDir, 'conversations'))).toBe(true);
    });

    it('should create a latest pointer', () => {
      createRunDir(tmpDir, 'run-1');
      const latestPath = join(tmpDir, '.anatoly', 'runs', 'latest');
      expect(existsSync(latestPath)).toBe(true);
    });

    it('should update latest pointer to most recent run', () => {
      createRunDir(tmpDir, 'run-1');
      createRunDir(tmpDir, 'run-2');
      const resolved = resolveRunDir(tmpDir);
      expect(resolved).not.toBeNull();
      expect(resolved!.endsWith('run-2')).toBe(true);
    });
  });

  describe('resolveRunDir', () => {
    it('should resolve a specific run by ID', () => {
      createRunDir(tmpDir, 'my-run');
      const result = resolveRunDir(tmpDir, 'my-run');
      expect(result).not.toBeNull();
      expect(result!.endsWith('my-run')).toBe(true);
    });

    it('should resolve latest when no ID given', () => {
      createRunDir(tmpDir, 'run-1');
      const result = resolveRunDir(tmpDir);
      expect(result).not.toBeNull();
    });

    it('should return null for nonexistent run', () => {
      expect(resolveRunDir(tmpDir, 'nonexistent')).toBeNull();
    });

    it('should return null when no runs exist', () => {
      expect(resolveRunDir(tmpDir)).toBeNull();
    });
  });

  describe('listRuns', () => {
    it('should return empty array when no runs exist', () => {
      expect(listRuns(tmpDir)).toEqual([]);
    });

    it('should list run directories sorted', () => {
      createRunDir(tmpDir, '2026-01-01_120000');
      createRunDir(tmpDir, '2026-01-02_120000');
      createRunDir(tmpDir, '2026-01-01_080000');
      const runs = listRuns(tmpDir);
      expect(runs).toEqual([
        '2026-01-01_080000',
        '2026-01-01_120000',
        '2026-01-02_120000',
      ]);
    });

    it('should not include latest in the list', () => {
      createRunDir(tmpDir, 'run-1');
      const runs = listRuns(tmpDir);
      expect(runs).not.toContain('latest');
    });
  });

  describe('purgeRuns', () => {
    it('should delete oldest runs keeping N most recent', () => {
      createRunDir(tmpDir, 'run-a');
      createRunDir(tmpDir, 'run-b');
      createRunDir(tmpDir, 'run-c');

      const deleted = purgeRuns(tmpDir, 1);
      expect(deleted).toBe(2);

      const remaining = listRuns(tmpDir);
      expect(remaining).toEqual(['run-c']);
    });

    it('should return 0 when nothing to purge', () => {
      createRunDir(tmpDir, 'run-a');
      expect(purgeRuns(tmpDir, 5)).toBe(0);
    });

    it('should handle empty runs directory', () => {
      expect(purgeRuns(tmpDir, 1)).toBe(0);
    });
  });

  describe('createMiniRun', () => {
    it('should create run directory with prefixed runId', () => {
      const result = createMiniRun(tmpDir, 'scan');
      expect(result.runId).toMatch(/^scan-\d{4}-\d{2}-\d{2}_\d{6}$/);
      expect(existsSync(result.runDir)).toBe(true);
    });

    it('should return correct logPath and conversationDir', () => {
      const result = createMiniRun(tmpDir, 'review');
      expect(result.logPath).toBe(join(result.runDir, 'anatoly.ndjson'));
      expect(result.conversationDir).toBe(join(result.runDir, 'conversations'));
    });

    it('should create conversations/ subdirectory', () => {
      const result = createMiniRun(tmpDir, 'watch');
      expect(existsSync(result.conversationDir)).toBe(true);
    });

    it('should purge all prefixed run variants', () => {
      createMiniRun(tmpDir, 'scan');
      createMiniRun(tmpDir, 'estimate');
      createMiniRun(tmpDir, 'review');
      createMiniRun(tmpDir, 'watch');
      const runs = listRuns(tmpDir);
      expect(runs).toHaveLength(4);
      // purgeRuns treats all variants uniformly
      const deleted = purgeRuns(tmpDir, 0);
      expect(deleted).toBe(4);
      expect(listRuns(tmpDir)).toEqual([]);
    });
  });
});
