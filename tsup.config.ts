import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  // Keep main.js external so the dynamic import from index.js stays a
  // runtime path lookup instead of being inlined back into the bootstrap.
  './main.js',
];

function resolveGitCommit(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  // Two entries: index.ts is a thin bootstrap (cwd recovery), main.ts is
  // the real app. Splitting them keeps the ESM-import hoisting from
  // loading the Claude Agent SDK before our cwd recovery runs.
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  splitting: false,
  external,
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
    PKG_COMMIT: JSON.stringify(resolveGitCommit()),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
  esbuildOptions(options) {
    options.loader = { ...options.loader, '.md': 'text' };
  },
});
