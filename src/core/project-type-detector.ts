// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Project Type Detection — Story 29.1
 *
 * Detects project type(s) from package.json using a decision tree.
 * Multiple types can be detected simultaneously.
 * Follows the detection table in src/standards/typescript-documentation.md.
 */

export type ProjectType =
  | 'Frontend'
  | 'Backend API'
  | 'ORM'
  | 'CLI'
  | 'Library'
  | 'Monorepo';

// --- Detection signals ---

const FRONTEND_DEPS = new Set([
  'react',
  'next',
  'vue',
  'nuxt',
  '@angular/core',
  'svelte',
  'solid-js',
]);

const BACKEND_DEPS = new Set([
  'express',
  'fastify',
  'hono',
  'koa',
  '@nestjs/core',
  '@hapi/hapi',
]);

const ORM_DEPS = new Set([
  'prisma',
  '@prisma/client',
  'drizzle-orm',
  'typeorm',
  'sequelize',
  'knex',
  '@mikro-orm/core',
]);

const CLI_DEPS = new Set([
  'commander',
  'yargs',
  'clipanion',
  'cac',
]);

/**
 * Detects project type(s) from a parsed package.json object.
 *
 * Decision tree:
 * 1. Merge dependencies + devDependencies into a single dep set
 * 2. Check each category independently (Frontend, Backend API, ORM, CLI, Monorepo)
 * 3. If no specific type matched, fall back to 'Library'
 * 4. Monorepo always appears first if detected
 */
export function detectProjectTypes(
  packageJson: Record<string, unknown>,
): ProjectType[] {
  const deps = getAllDependencyNames(packageJson);
  const types: ProjectType[] = [];

  // Monorepo — workspaces field (non-empty array or object with packages)
  const ws = packageJson['workspaces'];
  if (ws != null && !(Array.isArray(ws) && ws.length === 0)) {
    types.push('Monorepo');
  }

  // Frontend — framework deps
  if (hasAnyDep(deps, FRONTEND_DEPS)) {
    types.push('Frontend');
  }

  // Backend API — server framework deps
  if (hasAnyDep(deps, BACKEND_DEPS)) {
    types.push('Backend API');
  }

  // ORM — database ORM deps
  if (hasAnyDep(deps, ORM_DEPS)) {
    types.push('ORM');
  }

  // CLI — non-empty bin field OR CLI framework deps
  const bin = packageJson['bin'];
  const hasBin = typeof bin === 'string' ? bin.length > 0 : (bin != null && typeof bin === 'object' && Object.keys(bin as Record<string, unknown>).length > 0);
  if (hasBin || hasAnyDep(deps, CLI_DEPS)) {
    types.push('CLI');
  }

  // Library — default fallback when nothing else matched
  if (types.length === 0) {
    types.push('Library');
  }

  return types;
}

// --- Internal helpers ---

function getAllDependencyNames(
  packageJson: Record<string, unknown>,
): Set<string> {
  const names = new Set<string>();
  const deps = packageJson['dependencies'];
  const devDeps = packageJson['devDependencies'];
  if (deps && typeof deps === 'object') {
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      names.add(name);
    }
  }
  if (devDeps && typeof devDeps === 'object') {
    for (const name of Object.keys(devDeps as Record<string, unknown>)) {
      names.add(name);
    }
  }
  return names;
}

function hasAnyDep(deps: Set<string>, signals: Set<string>): boolean {
  for (const signal of signals) {
    if (deps.has(signal)) return true;
  }
  return false;
}
