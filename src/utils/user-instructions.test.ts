// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadUserInstructions, ANATOLY_MD_FILENAME } from './user-instructions.js';

describe('loadUserInstructions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- AC 2: Missing file ---

  it('returns hasInstructions=false when ANATOLY.md does not exist', () => {
    const result = loadUserInstructions(tempDir);
    expect(result.hasInstructions).toBe(false);
  });

  it('returns undefined for all axes when ANATOLY.md does not exist', () => {
    const result = loadUserInstructions(tempDir);
    expect(result.forAxis('correction')).toBeUndefined();
    expect(result.forAxis('utility')).toBeUndefined();
    expect(result.forAxis('best_practices')).toBeUndefined();
    expect(result.forAxis('documentation')).toBeUndefined();
  });

  it('does not throw when ANATOLY.md does not exist', () => {
    expect(() => loadUserInstructions(tempDir)).not.toThrow();
  });

  // --- AC 6: Empty file ---

  it('returns hasInstructions=false when ANATOLY.md is empty', () => {
    writeFileSync(join(tempDir, ANATOLY_MD_FILENAME), '');
    const result = loadUserInstructions(tempDir);
    expect(result.hasInstructions).toBe(false);
  });

  it('returns hasInstructions=false when ANATOLY.md has no H2 sections', () => {
    writeFileSync(join(tempDir, ANATOLY_MD_FILENAME), 'Some text without any headings.\nMore text.');
    const result = loadUserInstructions(tempDir);
    expect(result.hasInstructions).toBe(false);
  });

  // --- AC 1: File loading and parsing ---

  it('returns hasInstructions=true when ANATOLY.md has valid sections', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '## General\nWe use ESM only.\n\n## Correction\nAlways check null returns.',
    );
    const result = loadUserInstructions(tempDir);
    expect(result.hasInstructions).toBe(true);
  });

  it('forAxis returns General + axis-specific content concatenated', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '## General\nWe use ESM only.\n\n## Correction\nAlways check null returns.',
    );
    const result = loadUserInstructions(tempDir);
    const content = result.forAxis('correction');
    expect(content).toContain('We use ESM only.');
    expect(content).toContain('Always check null returns.');
  });

  it('forAxis returns only General content for axes without a specific section', () => {
    writeFileSync(join(tempDir, ANATOLY_MD_FILENAME), '## General\nWe use ESM only.');
    const result = loadUserInstructions(tempDir);
    const content = result.forAxis('utility');
    expect(content).toContain('We use ESM only.');
  });

  it('forAxis returns only axis-specific content when no General section', () => {
    writeFileSync(join(tempDir, ANATOLY_MD_FILENAME), '## Correction\nAlways check null returns.');
    const result = loadUserInstructions(tempDir);
    const content = result.forAxis('correction');
    expect(content).toContain('Always check null returns.');
    expect(content).not.toContain('General');
  });

  it('forAxis returns undefined for axes with no content and no General section', () => {
    writeFileSync(join(tempDir, ANATOLY_MD_FILENAME), '## Correction\nAlways check null returns.');
    const result = loadUserInstructions(tempDir);
    expect(result.forAxis('utility')).toBeUndefined();
  });

  // --- AC 4: Section normalization ---

  it('normalizes "Best Practices" to best_practices', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '## Best Practices\nPrefer const over let.',
    );
    const result = loadUserInstructions(tempDir);
    expect(result.forAxis('best_practices')).toContain('Prefer const over let.');
  });

  it('normalizes case-insensitively', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '## CORRECTION\nCheck nulls.\n\n## Documentation\nJSDoc everything.',
    );
    const result = loadUserInstructions(tempDir);
    expect(result.forAxis('correction')).toContain('Check nulls.');
    expect(result.forAxis('documentation')).toContain('JSDoc everything.');
  });

  // --- AC 3: Unrecognized sections ---

  it('silently ignores unrecognized sections', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '## General\nBase rules.\n\n## Deployment\nDeploy to AWS.\n\n## Correction\nCheck nulls.',
    );
    const result = loadUserInstructions(tempDir);
    expect(result.hasInstructions).toBe(true);
    expect(result.forAxis('correction')).toContain('Check nulls.');
    // Deployment section should not appear in any axis
    expect(result.forAxis('correction')).not.toContain('Deploy to AWS');
    expect(result.forAxis('utility')).not.toContain('Deploy to AWS');
  });

  // --- AC 5: Token length warning ---

  it('does not throw for very long sections', () => {
    const longContent = 'A'.repeat(10_000);
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      `## General\n${longContent}`,
    );
    expect(() => loadUserInstructions(tempDir)).not.toThrow();
    const result = loadUserInstructions(tempDir);
    expect(result.hasInstructions).toBe(true);
  });

  // --- Edge cases ---

  it('handles multiple axes in a single file', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      [
        '## General',
        'ESM only.',
        '',
        '## Correction',
        'Check nulls.',
        '',
        '## Tests',
        'Use vitest.',
        '',
        '## Documentation',
        'JSDoc required.',
      ].join('\n'),
    );
    const result = loadUserInstructions(tempDir);
    expect(result.forAxis('correction')).toContain('Check nulls.');
    expect(result.forAxis('correction')).toContain('ESM only.');
    expect(result.forAxis('tests')).toContain('Use vitest.');
    expect(result.forAxis('tests')).toContain('ESM only.');
    expect(result.forAxis('documentation')).toContain('JSDoc required.');
    expect(result.forAxis('documentation')).toContain('ESM only.');
  });

  it('trims section content', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '## Correction\n\n  Check nulls.  \n\n',
    );
    const result = loadUserInstructions(tempDir);
    const content = result.forAxis('correction')!;
    expect(content).toBe('Check nulls.');
  });

  it('exports ANATOLY_MD_FILENAME constant', () => {
    expect(ANATOLY_MD_FILENAME).toBe('ANATOLY.md');
  });

  it('handles H1 title before H2 sections', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '# My Project Instructions\n\nSome preamble.\n\n## Correction\nCheck nulls.',
    );
    const result = loadUserInstructions(tempDir);
    expect(result.hasInstructions).toBe(true);
    expect(result.forAxis('correction')).toContain('Check nulls.');
  });

  it('handles Overengineering section name', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '## Overengineering\nKeep it simple.',
    );
    const result = loadUserInstructions(tempDir);
    expect(result.forAxis('overengineering')).toContain('Keep it simple.');
  });

  it('handles Duplication section name', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '## Duplication\nDRY is fine but not at cost of readability.',
    );
    const result = loadUserInstructions(tempDir);
    expect(result.forAxis('duplication')).toContain('DRY is fine');
  });

  it('handles Utility section name', () => {
    writeFileSync(
      join(tempDir, ANATOLY_MD_FILENAME),
      '## Utility\nDead code is intentional in tests.',
    );
    const result = loadUserInstructions(tempDir);
    expect(result.forAxis('utility')).toContain('Dead code is intentional');
  });
});
