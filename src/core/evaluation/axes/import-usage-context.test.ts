// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { splitImportUsage } from './import-usage-context.js';
import type { Task } from '../../../schemas/task.js';

type ImportRef = NonNullable<Task['imports']>[number];
const imp = (source: string, symbols?: string[], extra: Partial<ImportRef> = {}): ImportRef => ({
  source,
  type: 'import',
  ...(symbols ? { symbols } : {}),
  ...extra,
});

describe('splitImportUsage', () => {
  it('flags a named import absent from the body as unused, keeps the used one', () => {
    const content = "import { Used, Dead } from 'x';\nexport const f = () => Used();\n";
    const { referenced, unused } = splitImportUsage(content, [imp('x', ['Used', 'Dead'])]);
    expect(referenced).toEqual(['Used']);
    expect(unused).toEqual(['Dead']);
  });

  it('does not mislabel an import used far down a large file (the Brain FP)', () => {
    const filler = 'const noise = 1;\n'.repeat(1400);
    const content = `import { Brain } from 'lucide-react';\n${filler}\nexport const Icon = () => <Brain />;\n`;
    const { referenced, unused } = splitImportUsage(content, [imp('lucide-react', ['Brain'])]);
    expect(referenced).toEqual(['Brain']);
    expect(unused).toEqual([]);
  });

  it('does not count the import statement itself as a use', () => {
    const content = "import { Solo } from 'x';\nexport const y = 1;\n";
    expect(splitImportUsage(content, [imp('x', ['Solo'])]).unused).toEqual(['Solo']);
  });

  it('handles multi-line named imports', () => {
    const content = "import {\n  A,\n  B,\n} from 'x';\nexport const f = () => B();\n";
    const { referenced, unused } = splitImportUsage(content, [imp('x', ['A', 'B'])]);
    expect(referenced).toEqual(['B']);
    expect(unused).toEqual(['A']);
  });

  it('ignores namespace and default imports', () => {
    const content = "import * as NS from 'x';\nimport D from 'y';\nexport const f = () => 1;\n";
    const { referenced, unused } = splitImportUsage(content, [
      imp('x', undefined, { namespace: true }),
      imp('y', ['default']),
    ]);
    expect(referenced).toEqual([]);
    expect(unused).toEqual([]);
  });

  it('treats a comment mention as referenced (conservative: never a false "unused")', () => {
    const content = "import { Maybe } from 'x';\n// Maybe is kept for a reason\nexport const y = 1;\n";
    const { referenced, unused } = splitImportUsage(content, [imp('x', ['Maybe'])]);
    expect(referenced).toEqual(['Maybe']);
    expect(unused).toEqual([]);
  });

  it('returns empty for a file with no analysable named imports', () => {
    expect(splitImportUsage('export const x = 1;\n', undefined)).toEqual({ referenced: [], unused: [] });
    expect(splitImportUsage("import './side-effect';\n", [imp('./side-effect')])).toEqual({ referenced: [], unused: [] });
  });
});
