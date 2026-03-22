// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Gold-Set Integration Tests — validates prompt reinforcements via real LLM calls.
 *
 * EXCLUDED from `npm run test` (see vitest.config.ts exclude pattern).
 * Run manually: npx vitest run src/prompts/__gold-set__/gold-set.test.ts
 *
 * Estimated cost: ~$1.12 per full run (Haiku model).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSingleTurnQuery } from '../../core/axis-evaluator.js';
import { resolveSystemPrompt, _resetPromptRegistry } from '../../core/prompt-resolver.js';
import { UtilityResponseSchema } from '../../core/axes/utility.js';
import { CorrectionResponseSchema } from '../../core/axes/correction.js';
import { DuplicationResponseSchema } from '../../core/axes/duplication.js';
import { OverengineeringResponseSchema } from '../../core/axes/overengineering.js';
import { TestsResponseSchema } from '../../core/axes/tests.js';
import { BestPracticesResponseSchema } from '../../core/axes/best-practices.js';
import { DocumentationResponseSchema } from '../../core/axes/documentation.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GOLD_SET_MODEL ?? 'claude-haiku-4-5-20251001';
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const TIMEOUT = 60_000; // 60s per test (LLM calls can be slow)

_resetPromptRegistry();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SymbolDef {
  exported: boolean;
  kind: string;
  name: string;
  lineStart: number;
  lineEnd: number;
}

function readFixture(name: string): string {
  return readFileSync(join(__dirname, name), 'utf-8');
}

function buildUserMessage(
  fileName: string,
  content: string,
  symbols: SymbolDef[],
  extra?: string,
): string {
  const parts: string[] = [];
  parts.push(`## File: \`${fileName}\``);
  parts.push('');
  parts.push('```typescript');
  parts.push(content);
  parts.push('```');
  parts.push('');
  parts.push('## Symbols to evaluate');
  parts.push('');
  if (symbols.length === 0) {
    parts.push('(none — file has no symbols)');
  } else {
    for (const s of symbols) {
      parts.push(
        `- ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (L${s.lineStart}–L${s.lineEnd})`,
      );
    }
  }
  parts.push('');
  if (extra) {
    parts.push(extra);
    parts.push('');
  }
  parts.push('Evaluate and output the JSON.');
  return parts.join('\n');
}

function buildBpUserMessage(fileName: string, content: string): string {
  const lines = content.split('\n');
  const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const parts: string[] = [];
  parts.push(`## File: \`${fileName}\``);
  parts.push('## Context: utility');
  parts.push('');
  parts.push('```typescript');
  parts.push(content);
  parts.push('```');
  parts.push('');
  parts.push('## File stats');
  parts.push(`- Lines: ${lineCount}`);
  parts.push('- Symbols: 0');
  parts.push('- Exported symbols: 0');
  parts.push('');
  parts.push('Evaluate all 17 rules and output the JSON.');
  return parts.join('\n');
}

async function runAxis<T>(
  axisId: string,
  userMessage: string,
  schema: import('zod').ZodType<T>,
): Promise<T> {
  const abortController = new AbortController();
  const systemPrompt = resolveSystemPrompt(axisId);
  const result = await runSingleTurnQuery<T>(
    {
      systemPrompt,
      userMessage,
      model: MODEL,
      projectRoot: PROJECT_ROOT,
      abortController,
    },
    schema,
  );
  return result.data;
}

// ---------------------------------------------------------------------------
// Fixture symbol definitions
// ---------------------------------------------------------------------------

const DEAD_CODE_SYMBOLS: SymbolDef[] = [
  { exported: true, kind: 'function', name: 'formatCurrency', lineStart: 7, lineEnd: 12 },
  { exported: true, kind: 'function', name: 'slugify', lineStart: 14, lineEnd: 21 },
  { exported: true, kind: 'function', name: 'debounce', lineStart: 23, lineEnd: 31 },
  { exported: true, kind: 'const', name: 'MAX_RETRIES', lineStart: 33, lineEnd: 33 },
  { exported: true, kind: 'const', name: 'DEFAULT_TIMEOUT_MS', lineStart: 35, lineEnd: 35 },
];

const FALSE_DUP_SYMBOLS: SymbolDef[] = [
  { exported: true, kind: 'function', name: 'calculateMean', lineStart: 12, lineEnd: 20 },
  { exported: true, kind: 'function', name: 'joinPath', lineStart: 27, lineEnd: 36 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Gold-Set: empty-file.ts → all axes return empty symbols', () => {
  const content = readFixture('empty-file.ts');
  const symbols: SymbolDef[] = [];
  const userMsg = buildUserMessage('gold-set/empty-file.ts', content, symbols);

  const perSymbolAxes = [
    { axis: 'utility', schema: UtilityResponseSchema },
    { axis: 'correction', schema: CorrectionResponseSchema },
    { axis: 'duplication', schema: DuplicationResponseSchema },
    { axis: 'overengineering', schema: OverengineeringResponseSchema },
    { axis: 'tests', schema: TestsResponseSchema },
    { axis: 'documentation', schema: DocumentationResponseSchema },
  ] as const;

  for (const { axis, schema } of perSymbolAxes) {
    it(
      `${axis} returns empty symbols array`,
      async () => {
        const data = await runAxis(axis, userMsg, schema);
        expect(data.symbols).toEqual([]);
      },
      TIMEOUT,
    );
  }
});

describe('Gold-Set: perfect-10.ts → best-practices score ≥ 9.0', () => {
  it(
    'best-practices score is at least 9.0',
    async () => {
      const content = readFixture('perfect-10.ts');
      const userMsg = buildBpUserMessage('gold-set/perfect-10.ts', content);
      const data = await runAxis('best_practices', userMsg, BestPracticesResponseSchema);
      expect(data.score).toBeGreaterThanOrEqual(9.0);
    },
    TIMEOUT,
  );
});

describe('Gold-Set: terrible-1.ts → best-practices score ≤ 3.0', () => {
  it(
    'best-practices score is at most 3.0',
    async () => {
      const content = readFixture('terrible-1.ts');
      const userMsg = buildBpUserMessage('gold-set/terrible-1.ts', content);
      const data = await runAxis('best_practices', userMsg, BestPracticesResponseSchema);
      expect(data.score).toBeLessThanOrEqual(3.0);
    },
    TIMEOUT,
  );
});

describe('Gold-Set: dead-code.ts → utility = DEAD for orphan exports', () => {
  it(
    'all exported symbols are classified as DEAD',
    async () => {
      const content = readFixture('dead-code.ts');
      const importAnalysis = DEAD_CODE_SYMBOLS.map(
        (s) => `- ${s.name} (exported): imported by 0 files — LIKELY DEAD`,
      ).join('\n');
      const userMsg = buildUserMessage(
        'gold-set/dead-code.ts',
        content,
        DEAD_CODE_SYMBOLS,
        `## Pre-computed Import Analysis\n\n${importAnalysis}`,
      );
      const data = await runAxis('utility', userMsg, UtilityResponseSchema);

      expect(data.symbols.length).toBe(DEAD_CODE_SYMBOLS.length);
      for (const sym of data.symbols) {
        expect(sym.utility, `${sym.name} should be DEAD`).toBe('DEAD');
      }
    },
    TIMEOUT,
  );
});

describe('Gold-Set: false-duplicate.ts → duplication = UNIQUE', () => {
  it(
    'both functions are classified as UNIQUE',
    async () => {
      const content = readFixture('false-duplicate.ts');
      const ragSection = [
        '## RAG — Semantic Duplication',
        '',
        '### calculateMean (L12–L20)',
        'Similar functions found:',
        '- **joinPath** in `gold-set/false-duplicate.ts` (score: 0.780)',
        '  Signature: (segments: string[]) => string',
        '  Complexity: 2/5',
        '',
        '### joinPath (L27–L36)',
        'Similar functions found:',
        '- **calculateMean** in `gold-set/false-duplicate.ts` (score: 0.780)',
        '  Signature: (values: number[]) => number',
        '  Complexity: 1/5',
      ].join('\n');
      const userMsg = buildUserMessage(
        'gold-set/false-duplicate.ts',
        content,
        FALSE_DUP_SYMBOLS,
        ragSection,
      );
      const data = await runAxis('duplication', userMsg, DuplicationResponseSchema);

      expect(data.symbols.length).toBe(2);
      for (const sym of data.symbols) {
        expect(sym.duplication, `${sym.name} should be UNIQUE`).toBe('UNIQUE');
      }
    },
    TIMEOUT,
  );
});

describe('Gold-Set: generated-protobuf.ts → lenient scoring for generated code', () => {
  it(
    'best-practices score reflects leniency for generated code',
    async () => {
      const content = readFixture('generated-protobuf.ts');
      const userMsg = buildBpUserMessage('gold-set/generated-protobuf.ts', content);
      const data = await runAxis('best_practices', userMsg, BestPracticesResponseSchema);
      // Generated code should get lenient treatment — score should not be terrible
      expect(data.score).toBeGreaterThanOrEqual(5.0);
    },
    TIMEOUT,
  );
});

describe('Gold-Set: monolith-500-lines.ts → all symbols covered', () => {
  it(
    'utility axis evaluates all 20 functions without truncation',
    async () => {
      const content = readFixture('monolith-500-lines.ts');
      // Extract exported function names from the file
      const funcNames = content
        .split('\n')
        .filter((line) => /^export function /.test(line))
        .map((line) => line.match(/export function (\w+)/)?.[1])
        .filter(Boolean) as string[];

      expect(funcNames.length).toBeGreaterThanOrEqual(20);

      const symbols: SymbolDef[] = funcNames.map((name) => ({
        exported: true,
        kind: 'function',
        name,
        lineStart: 1,
        lineEnd: 1, // Line numbers are approximate for this test
      }));

      const userMsg = buildUserMessage('gold-set/monolith-500-lines.ts', content, symbols);
      const data = await runAxis('utility', userMsg, UtilityResponseSchema);

      // The LLM should return exactly as many symbols as we provided
      expect(data.symbols.length).toBe(funcNames.length);
    },
    TIMEOUT,
  );
});

describe('Gold-Set: mixed-lang-sql.ts → SQL not penalized as bad TypeScript', () => {
  it(
    'best-practices score is reasonable (SQL template literals are valid)',
    async () => {
      const content = readFixture('mixed-lang-sql.ts');
      const userMsg = buildBpUserMessage('gold-set/mixed-lang-sql.ts', content);
      const data = await runAxis('best_practices', userMsg, BestPracticesResponseSchema);
      // SQL in template literals should not be penalized
      expect(data.score).toBeGreaterThanOrEqual(5.0);
    },
    TIMEOUT,
  );
});
