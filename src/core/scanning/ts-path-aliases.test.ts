// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTsPathAliases, resolveAliasCandidates } from './ts-path-aliases.js';

describe('detectTsPathAliases — extends array form (TS 5)', () => {
  it('discovers aliases declared in a parent referenced via an array `extends`', () => {
    const root = mkdtempSync(join(tmpdir(), 'anatoly-tsalias-'));
    try {
      // Parent named so it is NOT one of the auto-seeded files
      // (tsconfig.json / tsconfig.app.json / tsconfig.base.json): the only way
      // to reach it is through the array `extends` chain.
      writeFileSync(
        join(root, 'tooling.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ extends: ['./tooling.json'] }),
      );

      const rules = detectTsPathAliases(root);
      expect(rules.length).toBe(1);

      // Behaviour-level: the alias actually resolves.
      const candidates = resolveAliasCandidates('@/lib/api', rules);
      expect(candidates.some((c) => c.endsWith('src/lib/api'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still discovers aliases via the classic string `extends`', () => {
    const root = mkdtempSync(join(tmpdir(), 'anatoly-tsalias-'));
    try {
      writeFileSync(
        join(root, 'tooling.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ extends: './tooling.json' }),
      );

      const rules = detectTsPathAliases(root);
      expect(rules.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
