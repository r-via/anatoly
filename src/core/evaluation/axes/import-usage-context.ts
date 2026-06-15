// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { AxisContext } from '../contract.js';
import type { Task } from '../../../schemas/task.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove `import ... from '...'` / `export ... from '...'` statements (single-
 * or multi-line) and bare side-effect imports (`import './x'`) from the source,
 * so a symbol's own import specifier does not count as a reference to it.
 */
function stripImportStatements(src: string): string {
  return src
    .replace(/^[ \t]*(?:import|export)\b[\s\S]*?\bfrom\b[ \t]*['"][^'"]+['"][ \t]*;?/gm, '')
    .replace(/^[ \t]*import[ \t]*['"][^'"]+['"][ \t]*;?/gm, '');
}

/**
 * Split a file's NAMED imports into those referenced in the file body vs those
 * that appear only in their import statement (candidate unused).
 *
 * Conservative by design: a name matched ANYWHERE outside the import statements
 * (code, comments, or strings) is treated as referenced, so a genuinely-used
 * import is never mislabelled unused — exactly the false positive this guards
 * against (e.g. an import used only far down a large file). Namespace
 * (`import * as`) and default imports are not analysed (left to the LLM).
 */
export function splitImportUsage(
  fileContent: string,
  imports: Task['imports'],
): { referenced: string[]; unused: string[] } {
  const named = new Set<string>();
  for (const imp of imports ?? []) {
    if (imp.namespace) continue;
    for (const n of imp.symbols ?? []) {
      if (n && n !== 'default') named.add(n);
    }
  }
  if (named.size === 0) return { referenced: [], unused: [] };

  const body = stripImportStatements(fileContent);
  const referenced: string[] = [];
  const unused: string[] = [];
  for (const name of named) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(body)) referenced.push(name);
    else unused.push(name);
  }
  return { referenced: referenced.sort(), unused: unused.sort() };
}

/**
 * Prompt section giving the best-practices axis a deterministic, authoritative
 * unused-import verdict, so it never claims a referenced import is dead (and can
 * confidently flag the truly-unused ones — the highest-value best-practices
 * output). Returns '' when the file has no analysable named imports.
 */
export function renderImportUsageContext(ctx: AxisContext): string {
  const { unused } = splitImportUsage(ctx.fileContent, ctx.task.imports);
  // Nothing to assert when there are no named imports at all.
  const hasNamed = (ctx.task.imports ?? []).some(
    (imp) => !imp.namespace && (imp.symbols ?? []).some((n) => n && n !== 'default'),
  );
  if (!hasNamed) return '';

  const parts: string[] = [];
  parts.push('## Imports — unused-import ground truth (deterministic, authoritative)');
  parts.push('');
  parts.push(
    'A static reference check (each named import matched against the file body with import statements stripped) found:',
  );
  parts.push(
    unused.length > 0
      ? `- Genuinely UNUSED named imports (safe to flag for removal): ${unused.join(', ')}`
      : '- Genuinely UNUSED named imports: none.',
  );
  parts.push('');
  parts.push(
    'Every other named import in this file IS referenced — do NOT flag any import outside the list above as unused, even if you cannot spot its use. (Namespace `import * as` and default imports are not covered by this check; judge those yourself.)',
  );
  parts.push('');
  return parts.join('\n');
}
