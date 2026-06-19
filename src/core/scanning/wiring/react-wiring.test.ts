// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reactWiringRecognizer } from './react-wiring.js';
import { recognizeWiringEdges, type WiringContext } from './wiring-recognizer.js';
import type { Task } from '../../../schemas/task.js';

function task(file: string, imports: Array<{ source: string; symbols?: string[] }> = []): Task {
  return { file, imports } as unknown as Task;
}

function ctx(over: Partial<WiringContext>): WiringContext {
  return {
    projectRoot: '/proj',
    importers: [],
    exportsByFile: new Map(),
    // Identity-ish resolver: maps a './X' specifier to the project-relative path.
    resolveImport: (spec) => (spec.startsWith('.') ? `src/${spec.replace(/^\.\//, '')}.tsx` : undefined),
    frameworks: new Set(['react']),
    ...over,
  };
}

describe('reactWiringRecognizer — default-export components', () => {
  it('bridges a default import to the target\'s declared export name', () => {
    const c = ctx({
      importers: [task('src/App.tsx', [{ source: './pages/Auth', symbols: ['default'] }])],
      exportsByFile: new Map([['src/pages/Auth.tsx', new Set(['Auth'])]]),
      resolveImport: () => 'src/pages/Auth.tsx',
    });
    const edges = reactWiringRecognizer.recognize(c);
    expect(edges).toContainEqual({ symbol: 'Auth', sourceFile: 'src/pages/Auth.tsx', importer: 'src/App.tsx' });
  });

  it('does NOT add an edge for a named import (those already resolve by name)', () => {
    const c = ctx({
      importers: [task('src/App.tsx', [{ source: './lib/util', symbols: ['helper'] }])],
      exportsByFile: new Map([['src/lib/util.tsx', new Set(['helper'])]]),
      resolveImport: () => 'src/lib/util.tsx',
    });
    expect(reactWiringRecognizer.recognize(c)).toHaveLength(0);
  });

  it('ignores non-JSX importer files', () => {
    const c = ctx({
      importers: [task('src/server.ts', [{ source: './handler', symbols: ['default'] }])],
      exportsByFile: new Map([['src/handler.tsx', new Set(['handler'])]]),
      resolveImport: () => 'src/handler.tsx',
    });
    expect(reactWiringRecognizer.recognize(c)).toHaveLength(0);
  });
});

describe('reactWiringRecognizer — appliesTo (discovery)', () => {
  it('applies when react is a discovered framework', () => {
    expect(reactWiringRecognizer.appliesTo(ctx({ frameworks: new Set(['react']), importers: [task('a.ts')] }))).toBe(true);
  });
  it('applies on JSX presence even without framework detection', () => {
    expect(reactWiringRecognizer.appliesTo(ctx({ frameworks: new Set(), importers: [task('src/A.tsx')] }))).toBe(true);
  });
  it('does not apply to a non-JSX, non-React codebase', () => {
    expect(reactWiringRecognizer.appliesTo(ctx({ frameworks: new Set(['express']), importers: [task('src/a.ts')] }))).toBe(false);
  });
});

describe('reactWiringRecognizer — lazy/dynamic imports', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wiring-')); mkdirSync(join(dir, 'src'), { recursive: true }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('bridges a lazy(() => import("./Page")) route to the target exports', () => {
    writeFileSync(join(dir, 'src/App.tsx'), `const Page = lazy(() => import('./pages/Lazy'));\nexport default function App() { return <Page/>; }\n`);
    const c = ctx({
      projectRoot: dir,
      importers: [task('src/App.tsx')],
      exportsByFile: new Map([['src/pages/Lazy.tsx', new Set(['LazyPage'])]]),
      resolveImport: (spec) => (spec === './pages/Lazy' ? 'src/pages/Lazy.tsx' : undefined),
    });
    const edges = reactWiringRecognizer.recognize(c);
    expect(edges).toContainEqual({ symbol: 'LazyPage', sourceFile: 'src/pages/Lazy.tsx', importer: 'src/App.tsx' });
  });
});

describe('recognizeWiringEdges registry', () => {
  it('returns no edges when no recognizer applies', () => {
    const edges = recognizeWiringEdges(ctx({ frameworks: new Set(['express']), importers: [task('src/a.ts')] }));
    expect(edges).toHaveLength(0);
  });
});
