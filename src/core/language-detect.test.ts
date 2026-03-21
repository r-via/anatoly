// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectLanguages,
  classifyFile,
  buildDistribution,
  EXTENSION_MAP,
  FILENAME_MAP,
  DEFAULT_EXCLUDES,
} from './language-detect.js';

vi.mock('../utils/git.js', () => ({
  getGitTrackedFiles: vi.fn(),
}));

import { getGitTrackedFiles } from '../utils/git.js';

const mockedGit = vi.mocked(getGitTrackedFiles);

describe('language-detect', () => {
  // ------- classifyFile (pure function) -------
  describe('classifyFile', () => {
    it.each([
      ['src/index.ts', 'TypeScript'],
      ['src/App.tsx', 'TypeScript'],
      ['src/index.js', 'JavaScript'],
      ['src/App.jsx', 'JavaScript'],
      ['config.mjs', 'JavaScript'],
      ['config.cjs', 'JavaScript'],
      ['scripts/setup.sh', 'Shell'],
      ['scripts/deploy.bash', 'Shell'],
      ['scripts/migrate.py', 'Python'],
      ['src/main.rs', 'Rust'],
      ['cmd/main.go', 'Go'],
      ['src/Main.java', 'Java'],
      ['src/Program.cs', 'C#'],
      ['db/schema.sql', 'SQL'],
      ['.github/ci.yml', 'YAML'],
      ['config.yaml', 'YAML'],
      ['data.json', 'JSON'],
    ])('classifies %s as %s', (file, expected) => {
      expect(classifyFile(file)).toBe(expected);
    });

    it('classifies Dockerfile via FILENAME_MAP', () => {
      expect(classifyFile('Dockerfile')).toBe('Docker');
    });

    it('classifies nested Dockerfile', () => {
      expect(classifyFile('docker/Dockerfile')).toBe('Docker');
    });

    it('classifies Makefile via FILENAME_MAP', () => {
      expect(classifyFile('Makefile')).toBe('Makefile');
    });

    it('returns null for unknown extensions', () => {
      expect(classifyFile('README.md')).toBeNull();
      expect(classifyFile('image.png')).toBeNull();
    });

    it('returns null for extensionless files not in FILENAME_MAP', () => {
      expect(classifyFile('LICENSE')).toBeNull();
      expect(classifyFile('.gitignore')).toBeNull();
    });
  });

  // ------- buildDistribution (pure function) -------
  describe('buildDistribution', () => {
    it('AC 31.1.1: returns distribution sorted by percentage descending with correct ratios', () => {
      const files = [
        ...Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`),
        ...Array.from({ length: 10 }, (_, i) => `scripts/s${i}.sh`),
        ...Array.from({ length: 3 }, (_, i) => `scripts/p${i}.py`),
        ...Array.from({ length: 2 }, (_, i) => `config${i}.yml`),
      ];

      const result = buildDistribution(files);

      expect(result.languages).toHaveLength(4);
      expect(result.languages[0]).toEqual({ name: 'TypeScript', percentage: 87, fileCount: 100 });
      expect(result.languages[1]).toEqual({ name: 'Shell', percentage: 9, fileCount: 10 });
      expect(result.languages[2]).toEqual({ name: 'Python', percentage: 3, fileCount: 3 });
      expect(result.languages[3]).toEqual({ name: 'YAML', percentage: 2, fileCount: 2 });
      expect(result.totalFiles).toBe(115);
    });

    it('AC 31.1.2: groups .ts/.tsx under TypeScript and .js/.jsx/.mjs/.cjs under JavaScript', () => {
      const files = [
        'src/index.ts', 'src/App.tsx',
        'src/util.js', 'src/helper.jsx', 'config.mjs', 'config.cjs',
      ];

      const result = buildDistribution(files);

      const ts = result.languages.find(l => l.name === 'TypeScript');
      const js = result.languages.find(l => l.name === 'JavaScript');
      expect(ts?.fileCount).toBe(2);
      expect(js?.fileCount).toBe(4);
    });

    it('AC 31.1.3: filters languages below 1% threshold', () => {
      const files = [
        ...Array.from({ length: 200 }, (_, i) => `src/file${i}.ts`),
        'scripts/setup.sh',
      ];

      const result = buildDistribution(files);

      expect(result.languages).toHaveLength(1);
      expect(result.languages[0].name).toBe('TypeScript');
      expect(result.languages[0].percentage).toBe(100);
      expect(result.totalFiles).toBe(200);
    });

    it('AC 31.1.4: detects Dockerfile and Makefile via FILENAME_MAP', () => {
      const files = [
        ...Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`),
        'Dockerfile',
        'Makefile',
      ];

      const result = buildDistribution(files);

      const docker = result.languages.find(l => l.name === 'Docker');
      const makefile = result.languages.find(l => l.name === 'Makefile');
      expect(docker?.fileCount).toBe(1);
      expect(makefile?.fileCount).toBe(1);
    });

    it('AC 31.1.7: totalFiles equals sum of all returned fileCount values', () => {
      const files = [
        ...Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`),
        ...Array.from({ length: 10 }, (_, i) => `scripts/s${i}.sh`),
        ...Array.from({ length: 5 }, (_, i) => `scripts/p${i}.py`),
      ];

      const result = buildDistribution(files);

      const sum = result.languages.reduce((s, l) => s + l.fileCount, 0);
      expect(result.totalFiles).toBe(sum);
    });

    it('ignores files with unrecognized extensions', () => {
      const files = ['src/index.ts', 'README.md', 'LICENSE', '.gitignore'];

      const result = buildDistribution(files);

      expect(result.totalFiles).toBe(1);
      expect(result.languages).toHaveLength(1);
      expect(result.languages[0].name).toBe('TypeScript');
    });

    it('returns empty distribution for no recognizable files', () => {
      const result = buildDistribution(['README.md', 'LICENSE']);

      expect(result.totalFiles).toBe(0);
      expect(result.languages).toHaveLength(0);
    });

    it('returns empty distribution for empty input', () => {
      const result = buildDistribution([]);

      expect(result.totalFiles).toBe(0);
      expect(result.languages).toHaveLength(0);
    });

    it('sorts by percentage descending, then by name ascending for ties', () => {
      const files = [
        ...Array.from({ length: 5 }, (_, i) => `a${i}.py`),
        ...Array.from({ length: 5 }, (_, i) => `b${i}.sh`),
        ...Array.from({ length: 10 }, (_, i) => `c${i}.ts`),
      ];

      const result = buildDistribution(files);

      expect(result.languages[0].name).toBe('TypeScript');
      // Python and Shell both at 25% — sorted by name ascending
      expect(result.languages[1].name).toBe('Python');
      expect(result.languages[2].name).toBe('Shell');
    });
  });

  // ------- detectLanguages (integration with git) -------
  describe('detectLanguages', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('AC 31.1.5: excludes node_modules, dist, venv, .venv, __pycache__, target, bin, obj', () => {
      mockedGit.mockReturnValue(new Set([
        'src/index.ts',
        'src/util.ts',
        'node_modules/lodash/index.js',
        'dist/bundle.js',
        'venv/lib/helpers.py',
        '.venv/lib/helpers.py',
        '__pycache__/module.py',
        'target/debug/main.rs',
        'bin/tool.sh',
        'obj/Debug/Program.cs',
      ]));

      const result = detectLanguages('/project');

      expect(result.totalFiles).toBe(2);
      expect(result.languages).toHaveLength(1);
      expect(result.languages[0].name).toBe('TypeScript');
      expect(result.languages[0].fileCount).toBe(2);
    });

    it('AC 31.1.6: uses git-tracked files only', () => {
      mockedGit.mockReturnValue(new Set([
        'src/index.ts',
        'src/util.ts',
        'scripts/setup.sh',
      ]));

      const result = detectLanguages('/project');

      expect(mockedGit).toHaveBeenCalledWith('/project');
      expect(result.totalFiles).toBe(3);
    });

    it('returns empty distribution for non-git project', () => {
      mockedGit.mockReturnValue(null);

      const result = detectLanguages('/project');

      expect(result.totalFiles).toBe(0);
      expect(result.languages).toHaveLength(0);
    });

    it('applies additional custom excludes', () => {
      mockedGit.mockReturnValue(new Set([
        'src/index.ts',
        'vendor/lib.ts',
      ]));

      const result = detectLanguages('/project', ['vendor/']);

      expect(result.totalFiles).toBe(1);
      expect(result.languages[0].name).toBe('TypeScript');
    });

    it('excludes nested vendor directories', () => {
      mockedGit.mockReturnValue(new Set([
        'src/index.ts',
        'packages/api/node_modules/foo/index.js',
        'packages/web/dist/bundle.js',
      ]));

      const result = detectLanguages('/project');

      expect(result.totalFiles).toBe(1);
    });
  });

  // ------- Constants -------
  describe('constants', () => {
    it('EXTENSION_MAP covers all Tier 1 languages', () => {
      const languages = new Set(Object.values(EXTENSION_MAP));
      expect(languages.has('TypeScript')).toBe(true);
      expect(languages.has('JavaScript')).toBe(true);
      expect(languages.has('Shell')).toBe(true);
      expect(languages.has('Python')).toBe(true);
      expect(languages.has('Rust')).toBe(true);
      expect(languages.has('Go')).toBe(true);
      expect(languages.has('Java')).toBe(true);
      expect(languages.has('C#')).toBe(true);
      expect(languages.has('SQL')).toBe(true);
      expect(languages.has('YAML')).toBe(true);
      expect(languages.has('JSON')).toBe(true);
    });

    it('DEFAULT_EXCLUDES contains all required vendor directories', () => {
      const required = [
        'node_modules/', 'dist/', 'venv/', '.venv/',
        '__pycache__/', 'target/', 'bin/', 'obj/',
      ];
      for (const dir of required) {
        expect(DEFAULT_EXCLUDES).toContain(dir);
      }
    });

    it('FILENAME_MAP contains Dockerfile and Makefile', () => {
      expect(FILENAME_MAP['Dockerfile']).toBeDefined();
      expect(FILENAME_MAP['Makefile']).toBeDefined();
    });
  });
});
