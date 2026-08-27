// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { WiringRecognizer, WiringContext, WiringEdge } from './wiring-recognizer.js';

const JSX_EXT = /\.(tsx|jsx)$/;
// `lazy(() => import('./Page'))` / `await import('./Page')` route splitting.
const DYNAMIC_IMPORT = /\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

/**
 * React/JSX wiring recognizer.
 *
 * Two blind spots of the static import graph on React code:
 *
 *  1. **Default-exported components.** A default import is keyed under the
 *     synthetic name `default`, but components are default-exported and the
 *     consumers (flow's `resolveDead`, the utility axis) look a symbol up by
 *     its *declared* name. So `import Page from './Page'` + `<Page/>` leaves
 *     `Page` with zero name-keyed importers — it looks DEAD, and as a flow
 *     entry that reaches no effect it is flagged `unwired_flow`. This is the
 *     audio-app false-positive class: route/page components (Auth, Profile,
 *     AccountSettings…) mounted via `<Route element={<Page/>}/>`.
 *  2. **Lazy routes.** `lazy(() => import('./Page'))` is a call expression, not
 *     an import statement, so no edge is recorded at all.
 *
 * Fix: for every default import and every dynamic `import('…')` specifier in a
 * JSX file, mark the target module's *declared* exports as consumed by the
 * importer. Coarse on purpose — it over-marks USED (it can never manufacture a
 * false DEAD), mirroring the un-enriched import fallback in the usage graph.
 */
export const reactWiringRecognizer: WiringRecognizer = {
  id: 'react-jsx',

  appliesTo: (ctx: WiringContext): boolean =>
    ctx.frameworks.has('react') ||
    ctx.frameworks.has('next') ||
    ctx.frameworks.has('nextjs') ||
    ctx.frameworks.has('remix') ||
    // Fall back to JSX presence: a `.tsx`/`.jsx` file is React-shaped even when
    // framework detection did not fire.
    ctx.importers.some((t) => JSX_EXT.test(t.file)),

  recognize: (ctx: WiringContext): WiringEdge[] => {
    const edges: WiringEdge[] = [];

    const markTargetUsed = (resolved: string | undefined, importer: string): void => {
      if (!resolved || resolved === importer) return;
      const exports = ctx.exportsByFile.get(resolved);
      if (!exports) return;
      for (const sym of exports) edges.push({ symbol: sym, sourceFile: resolved, importer });
    };

    for (const task of ctx.importers) {
      if (!JSX_EXT.test(task.file)) continue;
      const importerAbs = resolve(ctx.projectRoot, task.file);

      // (a) Static default imports — `import Page from './Page'`.
      for (const ref of task.imports ?? []) {
        if (!ref.symbols?.includes('default')) continue;
        markTargetUsed(ctx.resolveImport(ref.source, importerAbs), task.file);
      }

      // (b) Dynamic imports — `lazy(() => import('./Page'))`. Scan source since
      // a call-expression import is not in the static import refs. Only JSX
      // files are read, and only those that actually contain `import(`.
      let source: string;
      try {
        source = readFileSync(importerAbs, 'utf-8');
      } catch {
        continue;
      }
      if (!source.includes('import(')) continue;
      for (const match of source.matchAll(DYNAMIC_IMPORT)) {
        markTargetUsed(ctx.resolveImport(match[1]!, importerAbs), task.file);
      }
    }

    return edges;
  },
};
