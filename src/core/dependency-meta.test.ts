import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadDependencyMeta, extractFileDeps } from './dependency-meta.js';
import type { DependencyMeta } from './dependency-meta.js';

describe('loadDependencyMeta', () => {
  it('should load dependencies from a real package.json', () => {
    const meta = loadDependencyMeta(resolve('.'));
    expect(meta).toBeDefined();
    expect(meta!.dependencies.size).toBeGreaterThan(0);
    // The project itself uses commander
    expect(meta!.dependencies.has('commander')).toBe(true);
  });

  it('should return undefined for a missing package.json', () => {
    const meta = loadDependencyMeta('/nonexistent/path');
    expect(meta).toBeUndefined();
  });

  it('should merge dependencies and devDependencies', () => {
    const meta = loadDependencyMeta(resolve('.'));
    expect(meta).toBeDefined();
    // vitest is a devDependency
    expect(meta!.dependencies.has('vitest')).toBe(true);
    // commander is a dependency
    expect(meta!.dependencies.has('commander')).toBe(true);
  });
});

describe('extractFileDeps', () => {
  const meta: DependencyMeta = {
    dependencies: new Map([
      ['commander', '^14.0.3'],
      ['zod', '^3.22.0'],
      ['express', '^4.18.0'],
      ['@anthropic-ai/claude-agent-sdk', '^0.1.0'],
    ]),
    engines: { node: '>=20.19' },
  };

  it('should extract bare imports matching project dependencies', () => {
    const content = `import type { Command } from 'commander';
import { z } from 'zod';
export function foo() {}`;

    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'commander', version: '^14.0.3' },
      { name: 'zod', version: '^3.22.0' },
    ]);
  });

  it('should handle scoped packages', () => {
    const content = `import { query } from '@anthropic-ai/claude-agent-sdk';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: '@anthropic-ai/claude-agent-sdk', version: '^0.1.0' },
    ]);
  });

  it('should handle subpath imports', () => {
    const content = `import { something } from 'zod/v4';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'zod', version: '^3.22.0' },
    ]);
  });

  it('should filter out node: builtins', () => {
    const content = `import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';`;

    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'zod', version: '^3.22.0' },
    ]);
  });

  it('should deduplicate multiple imports from the same package', () => {
    const content = `import type { Command } from 'commander';
import { Option } from 'commander';`;

    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'commander', version: '^14.0.3' },
    ]);
  });

  it('should return empty deps when no npm imports found', () => {
    const content = `import { resolve } from 'node:path';
import { foo } from './local.js';`;

    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([]);
  });

  it('should skip imports not in project dependencies', () => {
    const content = `import { something } from 'unknown-pkg';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([]);
  });

  it('should include nodeEngine when available', () => {
    const content = `import { z } from 'zod';`;
    const result = extractFileDeps(content, meta);
    expect(result.nodeEngine).toBe('>=20.19');
  });

  it('should omit nodeEngine when not available', () => {
    const metaNoEngine: DependencyMeta = {
      dependencies: new Map([['zod', '^3.22.0']]),
    };
    const content = `import { z } from 'zod';`;
    const result = extractFileDeps(content, metaNoEngine);
    expect(result.nodeEngine).toBeUndefined();
  });

  it('should handle type-only imports', () => {
    const content = `import type { Command } from 'commander';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'commander', version: '^14.0.3' },
    ]);
  });

  it('should handle export-from statements', () => {
    const content = `export { z } from 'zod';`;
    const result = extractFileDeps(content, meta);
    expect(result.deps).toEqual([
      { name: 'zod', version: '^3.22.0' },
    ]);
  });
});
