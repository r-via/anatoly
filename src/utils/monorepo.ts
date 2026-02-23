import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface MonorepoInfo {
  detected: boolean;
  tool: 'yarn' | 'pnpm' | 'npm' | 'nx' | 'turbo' | null;
  workspaces: string[];
}

/**
 * Detect monorepo structure by reading package.json workspaces,
 * pnpm-workspace.yaml, nx.json, or turbo.json.
 *
 * Returns a MonorepoInfo with detected=false for single-package projects.
 */
export function detectMonorepo(projectRoot: string): MonorepoInfo {
  const noMonorepo: MonorepoInfo = { detected: false, tool: null, workspaces: [] };

  // 1. Check pnpm-workspace.yaml (PNPM workspaces)
  const pnpmWorkspacePath = join(projectRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWorkspacePath)) {
    try {
      const content = readFileSync(pnpmWorkspacePath, 'utf-8');
      const packages = parsePnpmWorkspaces(content);
      if (packages.length > 0) {
        return { detected: true, tool: 'pnpm', workspaces: packages };
      }
    } catch {
      // Invalid YAML — skip
    }
  }

  // 2. Check package.json workspaces (Yarn/NPM)
  const pkgJsonPath = join(projectRoot, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
      const workspaces = extractWorkspaces(pkg);
      if (workspaces.length > 0) {
        return { detected: true, tool: 'yarn', workspaces };
      }
    } catch {
      // Invalid JSON — skip
    }
  }

  // 3. Check nx.json (Nx workspace)
  const nxPath = join(projectRoot, 'nx.json');
  if (existsSync(nxPath)) {
    return { detected: true, tool: 'nx', workspaces: ['packages/*'] };
  }

  // 4. Check turbo.json (Turbo workspace)
  const turboPath = join(projectRoot, 'turbo.json');
  if (existsSync(turboPath)) {
    return { detected: true, tool: 'turbo', workspaces: ['packages/*'] };
  }

  return noMonorepo;
}

/**
 * Extract workspace globs from package.json.
 * Supports both array format and {packages: [...]} format.
 */
function extractWorkspaces(pkg: Record<string, unknown>): string[] {
  const workspaces = pkg.workspaces;
  if (!workspaces) return [];

  if (Array.isArray(workspaces)) {
    return workspaces.filter((w): w is string => typeof w === 'string');
  }

  if (typeof workspaces === 'object' && workspaces !== null) {
    const obj = workspaces as Record<string, unknown>;
    if (Array.isArray(obj.packages)) {
      return obj.packages.filter((w): w is string => typeof w === 'string');
    }
  }

  return [];
}

/**
 * Parse pnpm-workspace.yaml to extract package globs.
 * Minimal YAML parsing — only handles the `packages:` list.
 */
function parsePnpmWorkspaces(content: string): string[] {
  const packages: string[] = [];
  let inPackages = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (trimmed.startsWith('- ')) {
        const value = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, '');
        packages.push(value);
      } else if (trimmed !== '' && !trimmed.startsWith('#')) {
        break; // End of packages list
      }
    }
  }

  return packages;
}
