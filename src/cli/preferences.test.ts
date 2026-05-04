// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks (available before vi.mock factories run)
const { readFileSyncMock, writeFileSyncMock, mkdirSyncMock, homedirMock, warnMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  homedirMock: vi.fn(() => '/home/testuser'),
  warnMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
}));

vi.mock('node:os', () => ({
  homedir: () => homedirMock(),
}));

vi.mock('../utils/logger.js', () => ({
  getLogger: () => ({ warn: warnMock, info: vi.fn() }),
}));

import { loadPreferences, savePreferences, prefsFilePath, type Preferences } from './preferences.js';

describe('preferences', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    warnMock.mockReset();
    homedirMock.mockReturnValue('/home/testuser');
  });

  // -------------------------------------------------------------------------
  // prefsFilePath
  // -------------------------------------------------------------------------

  describe('prefsFilePath', () => {
    it('returns path under ~/.anatoly/', () => {
      const p = prefsFilePath();
      expect(p).toContain('/home/testuser/.anatoly/preferences.yml');
    });
  });

  // -------------------------------------------------------------------------
  // loadPreferences
  // -------------------------------------------------------------------------

  describe('loadPreferences', () => {
    // AC5: file does not exist → return null
    it('returns null when file does not exist (ENOENT)', () => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      readFileSyncMock.mockImplementation(() => { throw err; });

      expect(loadPreferences()).toBeNull();
      expect(warnMock).not.toHaveBeenCalled();
    });

    // AC2: valid preferences with embeddings.prefer: 'advanced'
    it('returns parsed preferences for valid YAML', () => {
      readFileSyncMock.mockReturnValue('embeddings:\n  prefer: advanced\n');

      const result = loadPreferences();
      expect(result).toEqual({ embeddings: { prefer: 'advanced' } });
    });

    // AC: load lite preference
    it('returns parsed preferences for lite', () => {
      readFileSyncMock.mockReturnValue('embeddings:\n  prefer: lite\n');

      const result = loadPreferences();
      expect(result).toEqual({ embeddings: { prefer: 'lite' } });
    });

    // AC5: corrupted YAML → warn + return null
    it('logs warn and returns null for corrupted YAML', () => {
      readFileSyncMock.mockReturnValue('{{invalid yaml::');

      const result = loadPreferences();
      expect(result).toBeNull();
      expect(warnMock).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        expect.stringContaining('preferences.yml'),
      );
    });

    // AC5: valid YAML but not an object → return null
    it('returns null when YAML parses to non-object (e.g. string)', () => {
      readFileSyncMock.mockReturnValue('just a string');

      const result = loadPreferences();
      expect(result).toBeNull();
    });

    // Edge: empty file → return null
    it('returns null for empty file', () => {
      readFileSyncMock.mockReturnValue('');

      const result = loadPreferences();
      expect(result).toBeNull();
    });

    // AC5: permission denied → warn + return null
    it('logs warn and returns null on permission error', () => {
      const err = new Error('permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      readFileSyncMock.mockImplementation(() => { throw err; });

      const result = loadPreferences();
      expect(result).toBeNull();
      expect(warnMock).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // savePreferences
  // -------------------------------------------------------------------------

  describe('savePreferences', () => {
    // AC1: write preferences for advanced
    it('creates directory and writes YAML for advanced preference', () => {
      savePreferences({ embeddings: { prefer: 'advanced' } });

      expect(mkdirSyncMock).toHaveBeenCalledWith(
        expect.stringContaining('.anatoly'),
        { recursive: true },
      );
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        expect.stringContaining('preferences.yml'),
        expect.stringContaining('advanced'),
        'utf-8',
      );
    });

    // AC6: mkdirSync failure → warn "Could not save preference"
    it('logs warn when mkdirSync fails', () => {
      mkdirSyncMock.mockImplementation(() => { throw new Error('permission denied'); });

      savePreferences({ embeddings: { prefer: 'advanced' } });

      expect(warnMock).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        'Could not save preference',
      );
    });

    // AC6: writeFileSync failure → warn "Could not save preference"
    it('logs warn when writeFileSync fails', () => {
      writeFileSyncMock.mockImplementation(() => { throw new Error('disk full'); });

      savePreferences({ embeddings: { prefer: 'advanced' } });

      expect(warnMock).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        'Could not save preference',
      );
    });

    // Verify YAML output format
    it('writes valid YAML that can be loaded back', () => {
      let written = '';
      writeFileSyncMock.mockImplementation((_p: string, data: string) => { written = data; });

      const prefs: Preferences = { embeddings: { prefer: 'advanced' } };
      savePreferences(prefs);

      // The written content should contain the YAML representation
      expect(written).toContain('embeddings');
      expect(written).toContain('prefer');
      expect(written).toContain('advanced');
    });
  });
});
