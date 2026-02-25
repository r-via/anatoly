import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencyMeta {
  /** Package name -> version range from package.json */
  dependencies: Map<string, string>;
  /** Engine constraints, e.g. { node: '>=20.19' } */
  engines?: Record<string, string>;
}

export interface FileDependencyContext {
  /** Package name -> version range, only for packages imported by this file */
  deps: Array<{ name: string; version: string }>;
  /** Node engine constraint if available */
  nodeEngine?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load dependency metadata from the project's package.json.
 * Returns undefined if package.json is missing or unparsable.
 */
export function loadDependencyMeta(projectRoot: string): DependencyMeta | undefined {
  const pkgPath = resolve(projectRoot, 'package.json');

  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf-8');
  } catch {
    return undefined;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const deps = new Map<string, string>();

  const prodDeps = pkg.dependencies as Record<string, string> | undefined;
  if (prodDeps && typeof prodDeps === 'object') {
    for (const [name, version] of Object.entries(prodDeps)) {
      if (typeof version === 'string') deps.set(name, version);
    }
  }

  const devDeps = pkg.devDependencies as Record<string, string> | undefined;
  if (devDeps && typeof devDeps === 'object') {
    for (const [name, version] of Object.entries(devDeps)) {
      if (typeof version === 'string') deps.set(name, version);
    }
  }

  const engines = pkg.engines as Record<string, string> | undefined;

  return {
    dependencies: deps,
    ...(engines && typeof engines === 'object' ? { engines } : {}),
  };
}

/**
 * Extract the subset of project dependencies that are actually imported
 * by the given file content.
 */
export function extractFileDeps(fileContent: string, meta: DependencyMeta): FileDependencyContext {
  const seen = new Set<string>();
  const deps: Array<{ name: string; version: string }> = [];

  // Match bare import/export specifiers (not relative paths, not node: builtins)
  const importRe = /(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?|\*\s+as\s+\w+)\s+from\s+['"]([^'"./][^'"]*)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = importRe.exec(fileContent)) !== null) {
    const pkgName = toPackageName(match[1]);
    if (pkgName && !seen.has(pkgName)) {
      seen.add(pkgName);
      const version = meta.dependencies.get(pkgName);
      if (version) {
        deps.push({ name: pkgName, version });
      }
    }
  }

  return {
    deps,
    ...(meta.engines?.node ? { nodeEngine: meta.engines.node } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toPackageName(specifier: string): string | null {
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return specifier.split('/')[0];
}
