// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectLanguages,
  detectProjectProfile,
  classifyFile,
  buildDistribution,
  formatLanguageLine,
  formatFrameworkLine,
  EXTENSION_MAP,
  FILENAME_MAP,
  DEFAULT_EXCLUDES,
  type FrameworkInfo,
} from './language-detect.js';

vi.mock('../utils/git.js', () => ({
  getGitTrackedFiles: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { getGitTrackedFiles } from '../utils/git.js';
import { readFileSync, existsSync } from 'node:fs';

const mockedGit = vi.mocked(getGitTrackedFiles);
const mockedReadFile = vi.mocked(readFileSync);

/** Mock readFileSync to return content for specific paths, throw ENOENT for others. */
function mockFiles(files: Record<string, string>) {
  mockedReadFile.mockImplementation(((path: unknown) => {
    const p = String(path);
    if (p in files) return files[p];
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  }) as typeof readFileSync);
}

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

  // ------- detectProjectProfile (Story 31.2) -------
  describe('detectProjectProfile', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    // --- TypeScript/JavaScript frameworks ---

    it('AC 31.2.1: detects React from package.json dependencies', () => {
      mockedGit.mockReturnValue(new Set(['src/App.tsx', 'src/index.ts', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({
          dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
        }),
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual({
        id: 'react', name: 'React', language: 'typescript', category: 'frontend',
      });
    });

    it('AC 31.2.2: detects Next.js and suppresses React', () => {
      mockedGit.mockReturnValue(new Set(['src/page.tsx', 'src/layout.tsx', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({
          dependencies: { next: '^15.0.0', react: '^19.0.0' },
        }),
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual({
        id: 'nextjs', name: 'Next.js', language: 'typescript', category: 'fullstack',
      });
      expect(result.frameworks).not.toContainEqual(
        expect.objectContaining({ id: 'react' }),
      );
    });

    it('AC 31.2.3: detects Next.js from next.config.* at root', () => {
      mockedGit.mockReturnValue(new Set([
        'src/page.tsx', 'src/layout.tsx', 'next.config.mjs', 'package.json',
      ]));
      mockFiles({
        '/project/package.json': JSON.stringify({
          dependencies: { react: '^19.0.0' },
        }),
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual({
        id: 'nextjs', name: 'Next.js', language: 'typescript', category: 'fullstack',
      });
      // React suppressed by Next.js
      expect(result.frameworks).not.toContainEqual(
        expect.objectContaining({ id: 'react' }),
      );
    });

    it('AC 31.2.10: detects multiple frameworks simultaneously', () => {
      mockedGit.mockReturnValue(new Set(['src/app.ts', 'src/controller.ts', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({
          dependencies: { '@nestjs/core': '^10.0.0', prisma: '^5.0.0' },
        }),
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ id: 'nestjs' }),
      );
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ id: 'prisma' }),
      );
    });

    // --- Python frameworks ---

    it('AC 31.2.4: detects Django from requirements.txt', () => {
      mockedGit.mockReturnValue(new Set(['app.py', 'models.py', 'requirements.txt']));
      mockFiles({
        '/project/requirements.txt': 'django==5.1\ngunicorn==21.0\n',
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual({
        id: 'django', name: 'Django', language: 'python', category: 'fullstack',
      });
    });

    it('AC 31.2.5: detects FastAPI from pyproject.toml', () => {
      mockedGit.mockReturnValue(new Set(['app.py', 'routes.py', 'pyproject.toml']));
      mockFiles({
        '/project/pyproject.toml': '[project]\ndependencies = [\n  "fastapi>=0.100",\n]\n',
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual({
        id: 'fastapi', name: 'FastAPI', language: 'python', category: 'backend',
      });
    });

    // --- Rust frameworks ---

    it('AC 31.2.6: detects Actix Web from Cargo.toml', () => {
      mockedGit.mockReturnValue(new Set(['src/main.rs', 'src/routes.rs', 'Cargo.toml']));
      mockFiles({
        '/project/Cargo.toml': '[dependencies]\nactix-web = "4"\nserde = "1"\n',
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual({
        id: 'actix', name: 'Actix Web', language: 'rust', category: 'backend',
      });
    });

    // --- Go frameworks ---

    it('AC 31.2.7: detects Gin from go.mod', () => {
      mockedGit.mockReturnValue(new Set(['main.go', 'handlers.go', 'go.mod']));
      mockFiles({
        '/project/go.mod': 'module myapp\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual({
        id: 'gin', name: 'Gin', language: 'go', category: 'backend',
      });
    });

    // --- C# frameworks ---

    it('AC 31.2.8: detects ASP.NET from *.csproj', () => {
      mockedGit.mockReturnValue(new Set([
        'Program.cs', 'Controllers/HomeController.cs', 'MyApp.csproj',
      ]));
      mockFiles({
        '/project/MyApp.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web">\n'
          + '  <ItemGroup>\n'
          + '    <PackageReference Include="Microsoft.AspNetCore.OpenApi" />\n'
          + '  </ItemGroup>\n'
          + '</Project>',
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual({
        id: 'aspnet', name: 'ASP.NET', language: 'csharp', category: 'backend',
      });
    });

    // --- Java frameworks ---

    it('AC 31.2.9: detects Spring from pom.xml', () => {
      mockedGit.mockReturnValue(new Set([
        'src/main/java/App.java', 'src/main/java/Controller.java', 'pom.xml',
      ]));
      mockFiles({
        '/project/pom.xml': '<project>\n'
          + '  <dependencies>\n'
          + '    <dependency>\n'
          + '      <groupId>org.springframework</groupId>\n'
          + '    </dependency>\n'
          + '  </dependencies>\n'
          + '</project>',
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toContainEqual({
        id: 'spring', name: 'Spring', language: 'java', category: 'fullstack',
      });
    });

    // --- Edge cases ---

    it('AC 31.2.11: returns empty frameworks when no markers found', () => {
      mockedGit.mockReturnValue(new Set(['src/index.ts', 'src/util.ts', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({
          dependencies: { lodash: '^4.0.0' },
        }),
      });

      const result = detectProjectProfile('/project');

      expect(result.frameworks).toEqual([]);
    });

    it('AC 31.2.12: does not read config files for undetected languages (except workspace manifests)', () => {
      // Only TypeScript files — should not read go.mod, etc.
      // Cargo.toml IS read because deriveTypes checks it for workspace detection
      // (same as package.json is always read for monorepo/CLI detection).
      mockedGit.mockReturnValue(new Set(['src/index.ts', 'src/util.ts', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({ dependencies: {} }),
      });

      detectProjectProfile('/project');

      const readPaths = mockedReadFile.mock.calls.map(c => String(c[0]));
      expect(readPaths).not.toContain('/project/requirements.txt');
      expect(readPaths).not.toContain('/project/pyproject.toml');
      expect(readPaths).not.toContain('/project/go.mod');
      expect(readPaths).not.toContain('/project/pom.xml');
    });

    it('includes language distribution alongside frameworks', () => {
      mockedGit.mockReturnValue(new Set(['src/app.ts', 'src/util.ts', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({ dependencies: { react: '^19' } }),
      });

      const result = detectProjectProfile('/project');

      expect(result.languages.totalFiles).toBeGreaterThan(0);
      expect(result.languages.languages.some(l => l.name === 'TypeScript')).toBe(true);
    });

    it('returns empty profile for non-git project', () => {
      mockedGit.mockReturnValue(null);

      const result = detectProjectProfile('/project');

      expect(result.languages.totalFiles).toBe(0);
      expect(result.frameworks).toEqual([]);
    });

    // --- Story 29.1: Project Type Detection ACs ---

    it('AC 29.1.1: detects Frontend + ORM from react and prisma', () => {
      mockedGit.mockReturnValue(new Set(['src/App.tsx', 'src/db.ts', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({
          dependencies: { react: '^19.0.0', prisma: '^5.0.0' },
        }),
      });

      const result = detectProjectProfile('/project');

      expect(result.types).toContain('Frontend');
      expect(result.types).toContain('ORM');
    });

    it('AC 29.1.2: detects CLI from bin field and commander', () => {
      mockedGit.mockReturnValue(new Set(['src/cli.ts', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({
          bin: { mycli: './dist/cli.js' },
          dependencies: { commander: '^12.0.0' },
        }),
      });

      const result = detectProjectProfile('/project');

      expect(result.types).toContain('CLI');
    });

    it('AC 29.1.3: detects Monorepo from workspaces field', () => {
      mockedGit.mockReturnValue(new Set(['packages/a/index.ts', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({
          workspaces: ['packages/*'],
        }),
      });

      const result = detectProjectProfile('/project');

      expect(result.types).toContain('Monorepo');
    });

    it('AC 29.1.4: defaults to Library when no recognized dependencies', () => {
      mockedGit.mockReturnValue(new Set(['src/index.ts', 'package.json']));
      mockFiles({
        '/project/package.json': JSON.stringify({
          dependencies: { lodash: '^4.0.0' },
        }),
      });

      const result = detectProjectProfile('/project');

      expect(result.types).toEqual(['Library']);
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

  // ------- Formatting functions (Story 31.3) -------
  describe('formatLanguageLine', () => {
    it('AC 31.3.1: formats multiple languages with percentages', () => {
      const langs = [
        { name: 'TypeScript', percentage: 85, fileCount: 85 },
        { name: 'Shell', percentage: 10, fileCount: 10 },
        { name: 'Python', percentage: 3, fileCount: 3 },
        { name: 'YAML', percentage: 2, fileCount: 2 },
      ];

      expect(formatLanguageLine(langs)).toBe('TypeScript 85% · Shell 10% · Python 3% · YAML 2%');
    });

    it('formats a single language', () => {
      const langs = [{ name: 'TypeScript', percentage: 100, fileCount: 50 }];

      expect(formatLanguageLine(langs)).toBe('TypeScript 100%');
    });

    it('returns empty string for empty array', () => {
      expect(formatLanguageLine([])).toBe('');
    });
  });

  describe('formatFrameworkLine', () => {
    it('AC 31.3.2: formats multiple frameworks', () => {
      const fws: FrameworkInfo[] = [
        { id: 'nextjs', name: 'Next.js', language: 'typescript', category: 'fullstack' },
        { id: 'prisma', name: 'Prisma', language: 'typescript', category: 'orm' },
      ];

      expect(formatFrameworkLine(fws)).toBe('Next.js · Prisma');
    });

    it('formats a single framework', () => {
      const fws: FrameworkInfo[] = [{ id: 'react', name: 'React', language: 'typescript', category: 'frontend' }];

      expect(formatFrameworkLine(fws)).toBe('React');
    });

    it('AC 31.3.3: returns empty string for empty array', () => {
      expect(formatFrameworkLine([])).toBe('');
    });
  });
});
