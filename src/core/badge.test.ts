import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { injectBadge, buildBadgeMarkdown } from './badge.js';

describe('buildBadgeMarkdown', () => {
  it('builds static badge without verdict', () => {
    const md = buildBadgeMarkdown();
    expect(md).toContain('shields.io/badge/checked%20by-Anatoly-blue');
    expect(md).toContain('https://github.com/r-via/anatoly');
  });

  it('builds CLEAN verdict badge (brightgreen)', () => {
    const md = buildBadgeMarkdown('CLEAN', true);
    expect(md).toContain('brightgreen');
    expect(md).toContain('clean');
  });

  it('builds NEEDS_REFACTOR verdict badge (yellow)', () => {
    const md = buildBadgeMarkdown('NEEDS_REFACTOR', true);
    expect(md).toContain('yellow');
    expect(md).toContain('needs%20refactor');
  });

  it('builds CRITICAL verdict badge (red)', () => {
    const md = buildBadgeMarkdown('CRITICAL', true);
    expect(md).toContain('red');
    expect(md).toContain('critical');
  });

  it('falls back to static badge when includeVerdict is false', () => {
    const md = buildBadgeMarkdown('CRITICAL', false);
    expect(md).toContain('-blue');
    expect(md).not.toContain('red');
  });

  it('falls back to static badge when verdict is undefined', () => {
    const md = buildBadgeMarkdown(undefined, true);
    expect(md).toContain('-blue');
  });

  it('respects custom link', () => {
    const md = buildBadgeMarkdown(undefined, false, 'https://example.com/my-tool');
    expect(md).toContain('https://example.com/my-tool');
    expect(md).not.toContain('r-via/anatoly');
  });
});

describe('injectBadge', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-badge-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('injects badge at end of README', () => {
    writeFileSync(join(tempDir, 'README.md'), '# My Project\n\nHello world.\n');
    const result = injectBadge({ projectRoot: tempDir });

    expect(result).toEqual({ injected: true, updated: false });

    const content = readFileSync(join(tempDir, 'README.md'), 'utf-8');
    expect(content).toContain('<!-- checked-by-anatoly -->');
    expect(content).toContain('<!-- /checked-by-anatoly -->');
    expect(content).toContain('shields.io/badge/checked%20by-Anatoly-blue');
    expect(content).toMatch(/\n$/);
    // No double trailing newlines
    expect(content).not.toMatch(/\n\n$/);
  });

  it('updates existing badge in-place', () => {
    const original = [
      '# My Project',
      '',
      '## License',
      '',
      'MIT',
      '',
      '<!-- checked-by-anatoly -->',
      '[![Old Badge](https://old-url)](https://old-link)',
      '<!-- /checked-by-anatoly -->',
      '',
    ].join('\n');
    writeFileSync(join(tempDir, 'README.md'), original);

    const result = injectBadge({ projectRoot: tempDir });

    expect(result).toEqual({ injected: true, updated: true });

    const content = readFileSync(join(tempDir, 'README.md'), 'utf-8');
    expect(content).not.toContain('old-url');
    expect(content).toContain('shields.io/badge/checked%20by-Anatoly-blue');
    // Badge should still be after MIT section
    const mitIdx = content.indexOf('MIT');
    const badgeIdx = content.indexOf('<!-- checked-by-anatoly -->');
    expect(badgeIdx).toBeGreaterThan(mitIdx);
  });

  it('returns { injected: false, updated: false } when README does not exist', () => {
    const result = injectBadge({ projectRoot: tempDir });
    expect(result).toEqual({ injected: false, updated: false });
  });

  it('handles empty README', () => {
    writeFileSync(join(tempDir, 'README.md'), '');
    const result = injectBadge({ projectRoot: tempDir });

    expect(result).toEqual({ injected: true, updated: false });

    const content = readFileSync(join(tempDir, 'README.md'), 'utf-8');
    expect(content).toContain('<!-- checked-by-anatoly -->');
    expect(content).toMatch(/\n$/);
  });

  it('normalizes multiple trailing newlines', () => {
    writeFileSync(join(tempDir, 'README.md'), '# Project\n\n\n\n\n');
    injectBadge({ projectRoot: tempDir });

    const content = readFileSync(join(tempDir, 'README.md'), 'utf-8');
    // Should have exactly: content + \n\n + badge block + \n
    expect(content).not.toMatch(/\n{3,}<!-- checked-by-anatoly -->/);
  });

  it('handles README without trailing newline', () => {
    writeFileSync(join(tempDir, 'README.md'), '# Project');
    injectBadge({ projectRoot: tempDir });

    const content = readFileSync(join(tempDir, 'README.md'), 'utf-8');
    expect(content).toContain('<!-- checked-by-anatoly -->');
    expect(content).toMatch(/\n$/);
  });

  it('warns and skips when README is read-only', () => {
    const readmePath = join(tempDir, 'README.md');
    writeFileSync(readmePath, '# Project\n');
    chmodSync(readmePath, 0o444);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = injectBadge({ projectRoot: tempDir });

    expect(result).toEqual({ injected: false, updated: false });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('not writable'),
    );

    stderrSpy.mockRestore();
    // Restore write permission for cleanup
    chmodSync(readmePath, 0o644);
  });

  it('injects verdict badge when options specify it', () => {
    writeFileSync(join(tempDir, 'README.md'), '# Project\n');
    injectBadge({
      projectRoot: tempDir,
      verdict: 'CLEAN',
      includeVerdict: true,
    });

    const content = readFileSync(join(tempDir, 'README.md'), 'utf-8');
    expect(content).toContain('brightgreen');
    expect(content).toContain('clean');
  });

  it('uses custom link from options', () => {
    writeFileSync(join(tempDir, 'README.md'), '# Project\n');
    injectBadge({
      projectRoot: tempDir,
      link: 'https://custom.dev/tool',
    });

    const content = readFileSync(join(tempDir, 'README.md'), 'utf-8');
    expect(content).toContain('https://custom.dev/tool');
  });

  it('is idempotent — second run produces same result', () => {
    writeFileSync(join(tempDir, 'README.md'), '# Project\n');
    injectBadge({ projectRoot: tempDir });
    const first = readFileSync(join(tempDir, 'README.md'), 'utf-8');

    injectBadge({ projectRoot: tempDir });
    const second = readFileSync(join(tempDir, 'README.md'), 'utf-8');

    expect(second).toBe(first);
  });
});
