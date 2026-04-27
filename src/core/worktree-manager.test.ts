// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createWorktreeManager } from './worktree-manager.js';

/**
 * Helper: create a real temporary git repo with at least one commit
 * so that `git worktree add` has a HEAD to detach from.
 */
function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anatoly-wt-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# test');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('WorktreeManager', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(() => {
    // Clean up any worktrees before removing the temp dir
    try {
      execSync('git worktree prune', { cwd: repoDir, stdio: 'ignore' });
    } catch {
      // ignore
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // AC 47.1.1 — create(runId) creates worktree at .anatoly/worktrees/<runId>/
  // -----------------------------------------------------------------------

  it('AC 47.1.1: creates worktree in .anatoly/worktrees/<runId>/', async () => {
    const mgr = createWorktreeManager(repoDir);
    const runId = 'test-run-001';
    const wtPath = await mgr.create(runId);

    const expectedDir = join(repoDir, '.anatoly', 'worktrees', runId);
    expect(wtPath).toBe(expectedDir);
    expect(existsSync(wtPath)).toBe(true);
    // Verify it's a valid git worktree (has .git file, not .git directory)
    expect(existsSync(join(wtPath, '.git'))).toBe(true);
  });

  it('AC 47.1.1: worktree points to HEAD (detached HEAD)', async () => {
    const mgr = createWorktreeManager(repoDir);
    const wtPath = await mgr.create('test-detach');

    // In a detached HEAD worktree, `git rev-parse HEAD` should match the main repo
    const mainHead = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim();
    const wtHead = execSync('git rev-parse HEAD', { cwd: wtPath }).toString().trim();
    expect(wtHead).toBe(mainHead);
  });

  it('AC 47.1.1: returns absolute path', async () => {
    const mgr = createWorktreeManager(repoDir);
    const wtPath = await mgr.create('abs-path-test');
    // path.isAbsolute equivalent
    expect(wtPath.startsWith('/')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // AC 47.1.2 — remove(runId) removes worktree and directory
  // -----------------------------------------------------------------------

  it('AC 47.1.2: removes worktree via git worktree remove', async () => {
    const mgr = createWorktreeManager(repoDir);
    const runId = 'to-remove';
    const wtPath = await mgr.create(runId);
    expect(existsSync(wtPath)).toBe(true);

    await mgr.remove(runId);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('AC 47.1.2: directory no longer exists after remove', async () => {
    const mgr = createWorktreeManager(repoDir);
    const runId = 'dir-gone';
    await mgr.create(runId);

    await mgr.remove(runId);
    const worktreeDir = join(repoDir, '.anatoly', 'worktrees', runId);
    expect(existsSync(worktreeDir)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // AC 47.1.3 — failed removal logs error, persists needsCleanup flag
  // -----------------------------------------------------------------------

  it('AC 47.1.3: remove of non-existent worktree does not throw', async () => {
    const mgr = createWorktreeManager(repoDir);
    // Should not throw — just log and persist flag
    await expect(mgr.remove('does-not-exist')).resolves.not.toThrow();
  });

  it('AC 47.1.3: persists needsCleanup flag when worktree is unknown to git', async () => {
    const mgr = createWorktreeManager(repoDir);
    // Use a runId that was never created as a worktree — git worktree remove will fail
    const runId = 'never-created';

    // Create the directory manually so it looks like a stale worktree
    const fakeWtDir = join(repoDir, '.anatoly', 'worktrees', runId);
    mkdirSync(fakeWtDir, { recursive: true });

    await mgr.remove(runId);

    // needsCleanup flag should be persisted
    const flagPath = join(repoDir, '.anatoly', 'worktrees', '.needs-cleanup.json');
    expect(existsSync(flagPath)).toBe(true);
    const data = JSON.parse(readFileSync(flagPath, 'utf-8'));
    expect(data).toHaveProperty(runId);
  });

  // -----------------------------------------------------------------------
  // AC 47.1.4 — non-git repo throws explicit error
  // -----------------------------------------------------------------------

  it('AC 47.1.4: throws "Not a git repository" for non-git directory', () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'anatoly-no-git-'));
    try {
      expect(() => createWorktreeManager(nonGitDir)).toThrow('Not a git repository');
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('create throws if runId already has a worktree', async () => {
    const mgr = createWorktreeManager(repoDir);
    await mgr.create('dup-run');
    await expect(mgr.create('dup-run')).rejects.toThrow();
  });
});
