// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeAll } from 'vitest';
import { resolveSystemPrompt, _resetPromptRegistry } from '../core/prompt-resolver.js';

beforeAll(() => {
  _resetPromptRegistry();
});

// --- Story 34.1: Structural Fixes ---

const AXIS_IDS = ['utility', 'best_practices', 'documentation', 'correction', 'duplication', 'tests', 'overengineering'] as const;

describe('Story 34.1 — no JSON fences in axis output format', () => {
  for (const axis of AXIS_IDS) {
    it(`${axis} prompt does not contain \`\`\`json fences`, () => {
      const prompt = resolveSystemPrompt(axis);
      expect(prompt).not.toContain('```json');
      expect(prompt).not.toContain('```\n');
    });
  }
});

describe('Story 34.1 — all axis prompts say "raw JSON object"', () => {
  for (const axis of AXIS_IDS) {
    it(`${axis} prompt contains "raw JSON object" instruction`, () => {
      const prompt = resolveSystemPrompt(axis);
      expect(prompt).toContain('raw JSON object');
    });
  }
});

describe('Story 34.1 — deliberation uses dynamic axis count placeholder', () => {
  it('deliberation prompt contains {{AXIS_COUNT}} placeholder for dynamic interpolation', () => {
    const prompt = resolveSystemPrompt('deliberation');
    expect(prompt).toContain('{{AXIS_COUNT}}');
    expect(prompt).not.toMatch(/\b6 independent/i);
  });
});

describe('Story 34.1 — best-practices variants have rule count HTML comments', () => {
  const variants: Array<{ lang: string; guard: string }> = [
    { lang: 'bash', guard: 'ShellGuard' },
    { lang: 'python', guard: 'PyGuard' },
    { lang: 'rust', guard: 'RustGuard' },
    { lang: 'go', guard: 'GoGuard' },
    { lang: 'java', guard: 'JavaGuard' },
    { lang: 'csharp', guard: 'CSharpGuard' },
    { lang: 'sql', guard: 'SqlGuard' },
    { lang: 'yaml', guard: 'YamlGuard' },
    { lang: 'json', guard: 'JsonGuard' },
    { lang: 'react', guard: 'ReactGuard' },
    { lang: 'nextjs', guard: 'NextGuard' },
  ];

  for (const { lang } of variants) {
    it(`best_practices.${lang} has HTML comment documenting rule count and delta vs TypeScript base`, () => {
      const prompt = resolveSystemPrompt('best_practices', lang);
      // Must have an HTML comment with rule count and delta info
      expect(prompt).toMatch(/<!--.*Rules:\s*\d+.*delta.*TypeScript.*-->/i);
    });
  }
});
