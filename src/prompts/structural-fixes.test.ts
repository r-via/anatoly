// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeAll } from 'vitest';
import { resolveSystemPrompt, _resetPromptRegistry, _getRegistryKeys } from '../core/prompt-resolver.js';
import { composeAxisSystemPrompt } from '../core/axis-evaluator.js';

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

// --- Story 34.2: Guard Rails — Infrastructure anti-hallucination ---

describe('Story 34.2 — guard-rails.system.md exists and is registered', () => {
  it('guard-rails file exists and resolves via registry', () => {
    const prompt = resolveSystemPrompt('_shared.guard-rails');
    expect(prompt.length).toBeGreaterThan(50);
  });

  it('guard-rails has "Constraints" section', () => {
    const prompt = resolveSystemPrompt('_shared.guard-rails');
    expect(prompt).toMatch(/## Constraints/i);
  });

  it('guard-rails has "Confidence Guide" section', () => {
    const prompt = resolveSystemPrompt('_shared.guard-rails');
    expect(prompt).toMatch(/## Confidence Guide/i);
  });

  it('guard-rails contains anti-hallucination rule', () => {
    const prompt = resolveSystemPrompt('_shared.guard-rails');
    expect(prompt).toContain('ONLY output symbols that exist in the provided source code');
  });

  it('guard-rails contains confidence floor rule', () => {
    const prompt = resolveSystemPrompt('_shared.guard-rails');
    expect(prompt).toContain('Never output confidence below 50');
  });

  it('registry contains 37 entries', () => {
    const keys = _getRegistryKeys();
    expect(keys.length).toBe(37);
  });
});

describe('Story 34.2 — composed axis system prompt order', () => {
  for (const axis of AXIS_IDS) {
    it(`${axis} composed prompt has order: json-evaluator-wrapper → guard-rails → axis prompt`, () => {
      const composed = composeAxisSystemPrompt(resolveSystemPrompt(axis));
      const wrapperIdx = composed.indexOf('single-turn JSON evaluator');
      const guardIdx = composed.indexOf('ONLY output symbols that exist in the provided source code');
      const axisIdx = composed.indexOf(resolveSystemPrompt(axis).substring(0, 40));

      expect(wrapperIdx).toBeGreaterThanOrEqual(0);
      expect(guardIdx).toBeGreaterThan(wrapperIdx);
      expect(axisIdx).toBeGreaterThan(guardIdx);
    });
  }
});

// --- Story 34.3: Score Calibration ---

const ALL_BP_KEYS: Array<{ key: string; lang?: string }> = [
  { key: 'best_practices' },
  { key: 'best_practices', lang: 'bash' },
  { key: 'best_practices', lang: 'python' },
  { key: 'best_practices', lang: 'rust' },
  { key: 'best_practices', lang: 'go' },
  { key: 'best_practices', lang: 'java' },
  { key: 'best_practices', lang: 'csharp' },
  { key: 'best_practices', lang: 'sql' },
  { key: 'best_practices', lang: 'yaml' },
  { key: 'best_practices', lang: 'json' },
  { key: 'best_practices', lang: 'react' },
  { key: 'best_practices', lang: 'nextjs' },
];

describe('Story 34.3 — Score Calibration in best-practices prompts', () => {
  for (const { key, lang } of ALL_BP_KEYS) {
    const label = lang ? `${key}.${lang}` : key;

    it(`${label} has "Score Calibration" section`, () => {
      const prompt = resolveSystemPrompt(key, lang);
      expect(prompt).toMatch(/## Score Calibration/);
    });

    it(`${label} has 6 calibration levels (9-10, 7-8, 5-6, 3-4, 1-2, 0)`, () => {
      const prompt = resolveSystemPrompt(key, lang);
      expect(prompt).toMatch(/9[–-]10/);
      expect(prompt).toMatch(/7[–-]8/);
      expect(prompt).toMatch(/5[–-]6/);
      expect(prompt).toMatch(/3[–-]4/);
      expect(prompt).toMatch(/1[–-]2/);
      expect(prompt).toMatch(/\b0\b.*score/i);
    });
  }

  it('bash calibration mentions "set -euo pipefail"', () => {
    const prompt = resolveSystemPrompt('best_practices', 'bash');
    const calibrationSection = prompt.substring(prompt.indexOf('## Score Calibration'));
    expect(calibrationSection).toContain('set -euo pipefail');
  });

  it('python calibration mentions "type hints"', () => {
    const prompt = resolveSystemPrompt('best_practices', 'python');
    const calibrationSection = prompt.substring(prompt.indexOf('## Score Calibration'));
    expect(calibrationSection).toMatch(/type hint/i);
  });
});

// --- Story 34.4: Edge Case Handling ---

describe('Story 34.4 — code generation marker rule', () => {
  for (const axis of ['correction', 'best_practices', 'overengineering'] as const) {
    it(`${axis} prompt has "code generation marker" rule`, () => {
      const prompt = resolveSystemPrompt(axis);
      expect(prompt).toMatch(/code.generat/i);
      expect(prompt).toMatch(/leniency|lenient/i);
      expect(prompt).toMatch(/confidence.*-20|reduce.*confidence.*20/i);
    });
  }
});

describe('Story 34.4 — doc-writer constraints', () => {
  it('doc-writer has max 500 lines constraint', () => {
    const prompt = resolveSystemPrompt('doc-generation');
    expect(prompt).toMatch(/500\s*lines/i);
  });

  it('doc-writer specifies technical/third-person tone', () => {
    const prompt = resolveSystemPrompt('doc-generation');
    expect(prompt).toMatch(/third.person|technical.*tone/i);
  });

  it('doc-writer handles source/docs conflicts', () => {
    const prompt = resolveSystemPrompt('doc-generation');
    expect(prompt).toMatch(/conflict/i);
  });
});

describe('Story 34.4 — nlp-summarizer guard rails', () => {
  it('nlp-summarizer focuses on public interface for functions >200 lines', () => {
    const prompt = resolveSystemPrompt('rag.nlp-summarizer');
    expect(prompt).toMatch(/200\s*lines|public.*interface/i);
  });

  it('nlp-summarizer has fallback text', () => {
    const prompt = resolveSystemPrompt('rag.nlp-summarizer');
    expect(prompt).toContain('Purpose unclear from code alone');
  });

  it('nlp-summarizer specifies keyConcepts format', () => {
    const prompt = resolveSystemPrompt('rag.nlp-summarizer');
    expect(prompt).toMatch(/lowercase.*hyphenated|hyphenated.*lowercase/i);
    expect(prompt).toMatch(/30\s*char/i);
  });
});
