// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import type { LanguageInfo } from './language-detect.js';
import { autoDetectGlobs } from './auto-detect.js';

describe('autoDetectGlobs', () => {
  const lang = (name: string, pct = 10, fc = 5): LanguageInfo => ({
    name,
    percentage: pct,
    fileCount: fc,
  });

  // --- AC 31.4.1: Shell files produce shell globs ---
  it('AC 31.4.1: adds **/*.sh and **/*.bash for Shell', () => {
    const result = autoDetectGlobs([lang('Shell')]);
    expect(result.include).toContain('**/*.sh');
    expect(result.include).toContain('**/*.bash');
  });

  // --- AC 31.4.2: Python adds globs and auto-excludes ---
  it('AC 31.4.2: adds **/*.py for Python and auto-excludes venv dirs', () => {
    const result = autoDetectGlobs([lang('Python')]);
    expect(result.include).toContain('**/*.py');
    expect(result.exclude).toContain('venv/**');
    expect(result.exclude).toContain('.venv/**');
    expect(result.exclude).toContain('__pycache__/**');
  });

  // --- AC 31.4.3: YAML files produce yaml globs ---
  it('AC 31.4.3: adds **/*.yml and **/*.yaml for YAML', () => {
    const result = autoDetectGlobs([lang('YAML')]);
    expect(result.include).toContain('**/*.yml');
    expect(result.include).toContain('**/*.yaml');
  });

  // --- AC 31.4.4: Rust adds globs and auto-excludes target/ ---
  it('AC 31.4.4: adds **/*.rs for Rust and auto-excludes target/**', () => {
    const result = autoDetectGlobs([lang('Rust')]);
    expect(result.include).toContain('**/*.rs');
    expect(result.exclude).toContain('target/**');
  });

  // --- AC 31.4.7: TypeScript-only → no additional globs ---
  it('AC 31.4.7: returns empty for TypeScript-only', () => {
    const result = autoDetectGlobs([lang('TypeScript', 100, 50)]);
    expect(result.include).toEqual([]);
    expect(result.exclude).toEqual([]);
  });

  // --- AC 31.4.8: JSON includes and auto-excludes ---
  it('AC 31.4.8: adds **/*.json with lock/map auto-excludes', () => {
    const result = autoDetectGlobs([lang('JSON')]);
    expect(result.include).toContain('**/*.json');
    expect(result.exclude).toContain('package-lock.json');
    expect(result.exclude).toContain('node_modules/**/*.json');
    expect(result.exclude).toContain('**/*.map');
  });

  // --- Multiple languages merged ---
  it('merges globs for multiple languages', () => {
    const result = autoDetectGlobs([lang('Shell'), lang('Python'), lang('Rust')]);
    expect(result.include).toContain('**/*.sh');
    expect(result.include).toContain('**/*.py');
    expect(result.include).toContain('**/*.rs');
    expect(result.exclude).toContain('venv/**');
    expect(result.exclude).toContain('target/**');
  });

  // --- Deduplication ---
  it('deduplicates include and exclude entries', () => {
    // Two languages with overlapping excludes shouldn't duplicate
    const result = autoDetectGlobs([lang('Java'), lang('Rust')]);
    const targetCount = result.exclude.filter((e) => e === 'target/**').length;
    expect(targetCount).toBe(1);
  });

  // --- JavaScript/JSX globs ---
  it('adds JS/JSX globs for JavaScript', () => {
    const result = autoDetectGlobs([lang('JavaScript')]);
    expect(result.include).toContain('**/*.js');
    expect(result.include).toContain('**/*.jsx');
    expect(result.include).toContain('**/*.mjs');
    expect(result.include).toContain('**/*.cjs');
  });

  // --- Go globs ---
  it('adds **/*.go for Go', () => {
    const result = autoDetectGlobs([lang('Go')]);
    expect(result.include).toContain('**/*.go');
  });

  // --- C# globs and auto-excludes ---
  it('adds **/*.cs for C# and auto-excludes bin/obj', () => {
    const result = autoDetectGlobs([lang('C#')]);
    expect(result.include).toContain('**/*.cs');
    expect(result.exclude).toContain('bin/**');
    expect(result.exclude).toContain('obj/**');
  });

  // --- Java globs and auto-excludes ---
  it('adds **/*.java for Java and auto-excludes target/**', () => {
    const result = autoDetectGlobs([lang('Java')]);
    expect(result.include).toContain('**/*.java');
    expect(result.exclude).toContain('target/**');
  });

  // --- SQL globs ---
  it('adds **/*.sql for SQL', () => {
    const result = autoDetectGlobs([lang('SQL')]);
    expect(result.include).toContain('**/*.sql');
  });

  // --- Unknown language ignored ---
  it('ignores unknown language names', () => {
    const result = autoDetectGlobs([lang('Fortran')]);
    expect(result.include).toEqual([]);
    expect(result.exclude).toEqual([]);
  });

  // --- Empty input ---
  it('returns empty for empty input', () => {
    const result = autoDetectGlobs([]);
    expect(result.include).toEqual([]);
    expect(result.exclude).toEqual([]);
  });
});
