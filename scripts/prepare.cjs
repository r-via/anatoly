#!/usr/bin/env node
// Build dist/ via tsup. Resilient to npm's git-install bug where pacote
// spawns the inner `npm install --include=dev` while inheriting
// NPM_CONFIG_GLOBAL=true from the outer `npm install -g` parent. That
// inheritance causes the inner install to skip placing devDependencies,
// so tsup ends up missing and prepare fails with "tsup: not found".
//
// We work around it: if tsup isn't available locally, do a one-shot
// non-global install of our devDeps before invoking the build.

const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const cwd = process.cwd();
const tsupBin = resolve(cwd, 'node_modules', 'tsup', 'dist', 'cli-default.js');

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(tsupBin)) {
  console.log('anatoly prepare: tsup missing — installing devDeps locally (NPM_CONFIG_GLOBAL cleared)');
  run('npm', [
    'install',
    '--include=dev',
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--no-progress',
    '--ignore-scripts',
  ], {
    NPM_CONFIG_GLOBAL: 'false',
    NPM_CONFIG_PREFIX: '',
  });
}

console.log('anatoly prepare: building with tsup');
run(process.execPath, [tsupBin]);
