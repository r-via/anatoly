// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  firstExistingAncestor,
  isInsideAnatolyDir,
  pickRecoveryCandidates,
  recoverCwdIfBroken,
} from './boot-cwd.js';

describe('firstExistingAncestor', () => {
  it('returns the path itself when it exists', () => {
    const base = mkdtempSync(join(tmpdir(), 'anatoly-boot-'));
    try {
      expect(firstExistingAncestor(base)).toBe(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('walks up to the first ancestor that still exists', () => {
    const base = mkdtempSync(join(tmpdir(), 'anatoly-boot-'));
    const ghost = join(base, 'one', 'two', 'three');
    mkdirSync(ghost, { recursive: true });
    rmSync(join(base, 'one'), { recursive: true, force: true });
    try {
      expect(firstExistingAncestor(ghost)).toBe(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects relative paths to avoid implicit cwd lookups', () => {
    expect(firstExistingAncestor('relative/path')).toBeNull();
  });

  it('stops at / when no ancestor exists', () => {
    // /definitely-not-a-real-anatoly-path-xyz... walks up to / which exists.
    expect(firstExistingAncestor('/definitely-not-a-real-anatoly-path-xyz123')).toBe('/');
  });
});

describe('pickRecoveryCandidates', () => {
  it('keeps absolute PWD, HOME, then /tmp and /', () => {
    const candidates = pickRecoveryCandidates({
      PWD: '/home/u/dead',
      HOME: '/home/u',
    });
    expect(candidates).toEqual(['/home/u/dead', '/home/u', '/tmp', '/']);
  });

  it('drops non-absolute or missing entries', () => {
    const candidates = pickRecoveryCandidates({ PWD: 'relative', HOME: undefined });
    expect(candidates).toEqual(['/tmp', '/']);
  });
});

describe('isInsideAnatolyDir', () => {
  it('flags a cwd that is exactly the .anatoly folder', () => {
    expect(isInsideAnatolyDir('/home/u/proj/.anatoly')).toBe(true);
  });

  it('flags a cwd nested below .anatoly', () => {
    expect(isInsideAnatolyDir('/home/u/proj/.anatoly/runs/2026-01')).toBe(true);
  });

  it('does not flag a sibling folder that merely contains the substring', () => {
    expect(isInsideAnatolyDir('/home/u/proj/.anatoly-backup')).toBe(false);
    expect(isInsideAnatolyDir('/home/u/proj/my.anatoly.notes')).toBe(false);
  });

  it('does not flag a project root that has a .anatoly child', () => {
    expect(isInsideAnatolyDir('/home/u/proj')).toBe(false);
  });

  it('handles Windows-style backslash separators', () => {
    expect(isInsideAnatolyDir('C:\\Users\\u\\proj\\.anatoly\\runs')).toBe(true);
    expect(isInsideAnatolyDir('C:\\Users\\u\\proj')).toBe(false);
  });
});

describe('recoverCwdIfBroken', () => {
  it('is a no-op when cwd works', () => {
    let chdirCalls = 0;
    const result = recoverCwdIfBroken({
      cwdGetter: () => '/some/where',
      chdirFn: () => { chdirCalls++; },
      env: { PWD: '/tmp' },
    });
    expect(result.wasBroken).toBe(false);
    expect(result.recoveredTo).toBeNull();
    expect(chdirCalls).toBe(0);
  });

  it('chdir to first existing ancestor when cwd throws', () => {
    const base = mkdtempSync(join(tmpdir(), 'anatoly-boot-'));
    const ghost = join(base, 'a', 'b');
    mkdirSync(ghost, { recursive: true });
    rmSync(join(base, 'a'), { recursive: true, force: true });
    let chdirTo: string | null = null;
    try {
      const result = recoverCwdIfBroken({
        cwdGetter: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
        chdirFn: (p) => { chdirTo = p; },
        env: { PWD: ghost, HOME: '/nope' },
      });
      expect(result.wasBroken).toBe(true);
      expect(result.recoveredTo).toBe(base);
      expect(chdirTo).toBe(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('falls back to next candidate when chdir fails', () => {
    const base = mkdtempSync(join(tmpdir(), 'anatoly-boot-'));
    let firstAttempt = true;
    let finalTarget: string | null = null;
    try {
      const result = recoverCwdIfBroken({
        cwdGetter: () => { throw new Error('ENOENT'); },
        chdirFn: (p) => {
          if (firstAttempt) {
            firstAttempt = false;
            throw new Error('EACCES');
          }
          finalTarget = p;
        },
        env: { PWD: base, HOME: base },
      });
      expect(result.wasBroken).toBe(true);
      expect(result.recoveredTo).toBe(base);
      expect(finalTarget).toBe(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
