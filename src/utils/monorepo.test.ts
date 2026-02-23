import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectMonorepo } from './monorepo.js';

describe('detectMonorepo', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-mono-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return detected=false for a non-monorepo project', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    const result = detectMonorepo(tempDir);
    expect(result.detected).toBe(false);
    expect(result.tool).toBeNull();
    expect(result.workspaces).toEqual([]);
  });

  it('should detect Yarn/NPM workspaces (array format)', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*', 'apps/*'] }),
    );
    const result = detectMonorepo(tempDir);
    expect(result.detected).toBe(true);
    expect(result.tool).toBe('yarn');
    expect(result.workspaces).toEqual(['packages/*', 'apps/*']);
  });

  it('should detect Yarn workspaces (object format with packages key)', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
    );
    const result = detectMonorepo(tempDir);
    expect(result.detected).toBe(true);
    expect(result.tool).toBe('yarn');
    expect(result.workspaces).toEqual(['packages/*']);
  });

  it('should detect pnpm-workspace.yaml', () => {
    writeFileSync(
      join(tempDir, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n  - "apps/*"\n',
    );
    const result = detectMonorepo(tempDir);
    expect(result.detected).toBe(true);
    expect(result.tool).toBe('pnpm');
    expect(result.workspaces).toEqual(['packages/*', 'apps/*']);
  });

  it('should detect nx.json', () => {
    writeFileSync(join(tempDir, 'nx.json'), '{}');
    const result = detectMonorepo(tempDir);
    expect(result.detected).toBe(true);
    expect(result.tool).toBe('nx');
  });

  it('should detect turbo.json', () => {
    writeFileSync(join(tempDir, 'turbo.json'), '{}');
    const result = detectMonorepo(tempDir);
    expect(result.detected).toBe(true);
    expect(result.tool).toBe('turbo');
  });

  it('should prioritize pnpm-workspace.yaml over package.json workspaces', () => {
    writeFileSync(
      join(tempDir, 'pnpm-workspace.yaml'),
      'packages:\n  - "libs/*"\n',
    );
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    const result = detectMonorepo(tempDir);
    expect(result.tool).toBe('pnpm');
    expect(result.workspaces).toEqual(['libs/*']);
  });

  it('should return detected=false for empty directory', () => {
    const result = detectMonorepo(tempDir);
    expect(result.detected).toBe(false);
  });
});
