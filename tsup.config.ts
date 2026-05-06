import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
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
  entry: ['src/index.ts'],
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
