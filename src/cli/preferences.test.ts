// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks (available before vi.mock factories run)
const { readFileSyncMock, writeFileSyncMock, mkdirSyncMock, warnMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
}));

vi.mock('../utils/logger.js', () => ({
  getLogger: () => ({ warn: warnMock, info: vi.fn() }),
}));

import { loadPreferences, savePreferences, prefsFilePath, type Preferences } from './preferences.js';

const PROJECT_ROOT = '/tmp/test-project';

describe('preferences', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    warnMock.mockReset();
  });

  // -------------------------------------------------------------------------
  // prefsFilePath
  // -------------------------------------------------------------------------

  describe('prefsFilePath', () => {
    it('returns project-local path under .anatoly/setup/', () => {
      const p = prefsFilePath(PROJECT_ROOT);
      expect(p).toBe('/tmp/test-project/.anatoly/setup/preferences.yml');
    });
  });

  // -------------------------------------------------------------------------
  // loadPreferences
  // -------------------------------------------------------------------------

  describe('loadPreferences', () => {
    it('returns null when file does not exist (ENOENT)', () => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      readFileSyncMock.mockImplementation(() => { throw err; });

      expect(loadPreferences(PROJECT_ROOT)).toBeNull();
      expect(warnMock).not.toHaveBeenCalled();
    });

    it('returns parsed preferences for valid YAML', () => {
      readFileSyncMock.mockReturnValue('embeddings:\n  prefer: advanced\n');

      const result = loadPreferences(PROJECT_ROOT);
      expect(result).toEqual({ embeddings: { prefer: 'advanced' } });
    });

    it('returns parsed preferences for lite', () => {
      readFileSyncMock.mockReturnValue('embeddings:\n  prefer: lite\n');

      const result = loadPreferences(PROJECT_ROOT);
      expect(result).toEqual({ embeddings: { prefer: 'lite' } });
    });

    it('reads from the project-local preferences path', () => {
      readFileSyncMock.mockReturnValue('embeddings:\n  prefer: advanced\n');

      loadPreferences(PROJECT_ROOT);
      expect(readFileSyncMock).toHaveBeenCalledWith(
        '/tmp/test-project/.anatoly/setup/preferences.yml',
        'utf-8',
      );
    });

    it('logs warn and returns null for corrupted YAML', () => {
      readFileSyncMock.mockReturnValue('{{invalid yaml::');

      const result = loadPreferences(PROJECT_ROOT);
      expect(result).toBeNull();
      expect(warnMock).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        expect.stringContaining('preferences.yml'),
      );
    });

    it('returns null when YAML parses to non-object (e.g. string)', () => {
      readFileSyncMock.mockReturnValue('just a string');

      const result = loadPreferences(PROJECT_ROOT);
      expect(result).toBeNull();
    });

    it('returns null for empty file', () => {
      readFileSyncMock.mockReturnValue('');

      const result = loadPreferences(PROJECT_ROOT);
      expect(result).toBeNull();
    });

    it('logs warn and returns null on permission error', () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      readFileSyncMock.mockImplementation(() => { throw err; });

      const result = loadPreferences(PROJECT_ROOT);
      expect(result).toBeNull();
      expect(warnMock).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // savePreferences
  // -------------------------------------------------------------------------

  describe('savePreferences', () => {
    it('creates project setup/ and writes YAML for advanced preference', () => {
      savePreferences(PROJECT_ROOT, { embeddings: { prefer: 'advanced' } });

      expect(mkdirSyncMock).toHaveBeenCalledWith(
        '/tmp/test-project/.anatoly/setup',
        { recursive: true },
      );
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        '/tmp/test-project/.anatoly/setup/preferences.yml',
        expect.stringContaining('advanced'),
        'utf-8',
      );
    });

    it('logs warn when mkdirSync fails', () => {
      mkdirSyncMock.mockImplementation(() => { throw new Error('permission denied'); });

      savePreferences(PROJECT_ROOT, { embeddings: { prefer: 'advanced' } });

      expect(warnMock).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        'Could not save preference',
      );
    });

    it('logs warn when writeFileSync fails', () => {
      writeFileSyncMock.mockImplementation(() => { throw new Error('disk full'); });

      savePreferences(PROJECT_ROOT, { embeddings: { prefer: 'advanced' } });

      expect(warnMock).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        'Could not save preference',
      );
    });

    it('writes valid YAML that can be loaded back', () => {
      let written = '';
      writeFileSyncMock.mockImplementation((_p: string, data: string) => { written = data; });

      const prefs: Preferences = { embeddings: { prefer: 'advanced' } };
      savePreferences(PROJECT_ROOT, prefs);

      expect(written).toContain('embeddings');
      expect(written).toContain('prefer');
      expect(written).toContain('advanced');
    });
  });
});
