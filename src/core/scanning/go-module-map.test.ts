// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildGoPackageMap } from './go-module-map.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anatoly-gomod-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function goMod(rel: string, modulePath: string): void {
  const abs = join(dir, rel, 'go.mod');
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `module ${modulePath}\n\ngo 1.21\n`);
}

describe('buildGoPackageMap', () => {
  it('keys each package by <module>/<dir> and groups sibling files', () => {
    goMod('', 'example.com/m');
    const map = buildGoPackageMap(dir, [
      'internal/util/a.go',
      'internal/util/b.go',
      'cmd/app/main.go',
    ]);
    expect(map.get('example.com/m/internal/util')).toEqual(['internal/util/a.go', 'internal/util/b.go']);
    expect(map.get('example.com/m/cmd/app')).toEqual(['cmd/app/main.go']);
  });

  it('maps a root-level package to the bare module path', () => {
    goMod('', 'example.com/m');
    const map = buildGoPackageMap(dir, ['main.go']);
    expect(map.get('example.com/m')).toEqual(['main.go']);
  });

  it('attributes files to the deepest enclosing go.mod (nested module)', () => {
    goMod('', 'example.com/root');
    goMod('sub', 'example.com/sub');
    const map = buildGoPackageMap(dir, ['app/app.go', 'sub/pkg/lib.go']);
    expect(map.get('example.com/root/app')).toEqual(['app/app.go']);
    expect(map.get('example.com/sub/pkg')).toEqual(['sub/pkg/lib.go']);
    // The nested-module file must NOT be keyed under the root module.
    expect(map.get('example.com/root/sub/pkg')).toBeUndefined();
  });

  it('ignores non-Go files and returns empty when there is no go.mod', () => {
    // No go.mod written.
    const map = buildGoPackageMap(dir, ['internal/util/a.go', 'README.md']);
    expect(map.size).toBe(0);
  });
});
