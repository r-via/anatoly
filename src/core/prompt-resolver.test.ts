// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { globSync } from 'tinyglobby';
import {
  resolveSystemPrompt,
  registerPrompt,
  _clearPromptRegistry,
  _resetPromptRegistry,
  _getRegistryKeys,
  _getRegistrySnapshot,
} from './prompt-resolver.js';

describe('resolveSystemPrompt', () => {
  beforeEach(() => {
    _clearPromptRegistry();
  });

  // AC 31.14.1: Framework-specific prompt
  it('AC 31.14.1: returns framework prompt for tsx in Next.js project', () => {
    registerPrompt('best_practices', 'default best practices');
    registerPrompt('best_practices.typescript', 'TS best practices');
    registerPrompt('best_practices.nextjs', 'Next.js best practices');

    expect(resolveSystemPrompt('best_practices', 'typescript', 'nextjs'))
      .toBe('Next.js best practices');
  });

  // AC 31.14.2: React framework prompt
  it('AC 31.14.2: returns react prompt for tsx in React project', () => {
    registerPrompt('best_practices', 'default best practices');
    registerPrompt('best_practices.typescript', 'TS best practices');
    registerPrompt('best_practices.react', 'React best practices');

    expect(resolveSystemPrompt('best_practices', 'typescript', 'react'))
      .toBe('React best practices');
  });

  // AC 31.14.3: Falls back to language when no framework prompt
  it('AC 31.14.3: falls back to language prompt when framework prompt missing', () => {
    registerPrompt('best_practices', 'default best practices');
    registerPrompt('best_practices.python', 'Python best practices');

    expect(resolveSystemPrompt('best_practices', 'python', 'django'))
      .toBe('Python best practices');
  });

  // AC 31.14.4: Falls back to default for unknown language
  it('AC 31.14.4: falls back to default for unknown language', () => {
    registerPrompt('best_practices', 'default best practices');

    expect(resolveSystemPrompt('best_practices', 'cobol'))
      .toBe('default best practices');
  });

  // AC 31.14.5: Cascade order framework → language → default
  it('AC 31.14.5: checks framework → language → default in order', () => {
    registerPrompt('best_practices', 'DEFAULT');
    registerPrompt('best_practices.typescript', 'LANGUAGE');
    registerPrompt('best_practices.nextjs', 'FRAMEWORK');

    // All three registered → framework wins
    expect(resolveSystemPrompt('best_practices', 'typescript', 'nextjs')).toBe('FRAMEWORK');

    // No framework arg → language wins
    expect(resolveSystemPrompt('best_practices', 'typescript')).toBe('LANGUAGE');

    // No language or framework → default wins
    expect(resolveSystemPrompt('best_practices')).toBe('DEFAULT');
  });

  // AC 31.14.6: TypeScript default prompts unchanged (zero regression)
  it('AC 31.14.6: default prompts match existing axis prompts', () => {
    _resetPromptRegistry();

    const prompt = resolveSystemPrompt('best_practices');
    expect(prompt).toContain('best practices');
    expect(prompt.length).toBeGreaterThan(100);
  });

  // Additional: all 7 default axes resolve
  it('resolves default prompts for all 7 axes', () => {
    _resetPromptRegistry();

    const axes = ['utility', 'best_practices', 'documentation', 'correction', 'duplication', 'tests', 'overengineering'];
    for (const axis of axes) {
      const prompt = resolveSystemPrompt(axis);
      expect(prompt.length).toBeGreaterThan(50);
    }
  });

  // Additional: throws for unknown axis
  it('throws for unknown axis with no prompt registered', () => {
    expect(() => resolveSystemPrompt('nonexistent')).toThrow('No system prompt found');
  });

  // Additional: trimEnd applied to registered content
  it('trims trailing whitespace from registered prompts', () => {
    registerPrompt('test_axis', 'content with trailing space   \n\n');
    expect(resolveSystemPrompt('test_axis')).toBe('content with trailing space');
  });
});

// --- Story 33.3: Universal registry — new domain keys ---

describe('universal registry — new domain keys', () => {
  beforeEach(() => {
    _resetPromptRegistry();
  });

  it('resolves deliberation prompt', () => {
    const prompt = resolveSystemPrompt('deliberation');
    expect(prompt).toContain('Deliberation Judge');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('resolves doc-generation prompt', () => {
    const prompt = resolveSystemPrompt('doc-generation');
    expect(prompt).toContain('documentation writer');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('resolves doc-generation.architecture variant', () => {
    const prompt = resolveSystemPrompt('doc-generation.architecture');
    expect(prompt).toContain('Mermaid');
  });

  it('resolves doc-generation.api-reference variant', () => {
    const prompt = resolveSystemPrompt('doc-generation.api-reference');
    expect(prompt).toContain('usage example');
  });

  it('resolves rag.section-refiner prompt', () => {
    const prompt = resolveSystemPrompt('rag.section-refiner');
    expect(prompt).toContain('documentation analyzer');
  });

  it('resolves rag.nlp-summarizer prompt', () => {
    const prompt = resolveSystemPrompt('rag.nlp-summarizer');
    expect(prompt).toContain('code documentation assistant');
  });

  it('resolves _shared.json-evaluator-wrapper prompt', () => {
    const prompt = resolveSystemPrompt('_shared.json-evaluator-wrapper');
    expect(prompt).toContain('single-turn JSON evaluator');
  });

  it('resolves correction.verification prompt', () => {
    const prompt = resolveSystemPrompt('correction.verification');
    expect(prompt).toContain('verification agent');
  });

  it('registry contains exactly 41 entries after reset', () => {
    const expectedKeys = [
      'utility', 'best_practices', 'documentation', 'correction', 'duplication', 'tests', 'overengineering',
      'best_practices.bash', 'best_practices.python', 'best_practices.rust', 'best_practices.go',
      'best_practices.java', 'best_practices.csharp', 'best_practices.sql', 'best_practices.yaml', 'best_practices.json',
      'documentation.bash', 'documentation.python', 'documentation.rust', 'documentation.go',
      'documentation.java', 'documentation.csharp', 'documentation.sql', 'documentation.yaml',
      'best_practices.react', 'best_practices.nextjs', 'documentation.react', 'documentation.nextjs',
      'deliberation', 'doc-generation', 'doc-generation.architecture', 'doc-generation.api-reference', 'doc-generation.coherence-review', 'doc-generation.content-review', 'doc-generation.updater',
      'rag.section-refiner', 'rag.nlp-summarizer', '_shared.json-evaluator-wrapper', '_shared.guard-rails', 'correction.verification',
      'refinement.tier3-investigation',
    ];
    for (const key of expectedKeys) {
      expect(() => resolveSystemPrompt(key), `key "${key}" should resolve`).not.toThrow();
    }
    const keys = _getRegistryKeys();
    expect(keys.length).toBe(expectedKeys.length);
  });
});

// --- Story 33.4: Bidirectional coherence, snapshot, and regression guards ---

describe('Story 33.4 — registry coherence', () => {
  /**
   * Builds a mapping from registry key → expected relative .system.md file path.
   * This is the single source of truth for the key↔file relationship,
   * derived from the key naming conventions documented in prompt-resolver.ts.
   */
  function keyToExpectedFile(key: string): string {
    // Axis keys: underscores → hyphens, live in axes/
    const axisIds = ['utility', 'best_practices', 'documentation', 'correction', 'duplication', 'tests', 'overengineering'];
    const axisBase = key.split('.')[0];
    if (axisIds.includes(axisBase) && key !== 'correction.verification') {
      const fileName = key.replace(/_/g, '-');
      return `axes/${fileName}.system.md`;
    }
    // correction.verification is a special axis variant
    if (key === 'correction.verification') {
      return 'axes/correction.verification.system.md';
    }
    // deliberation → deliberation/deliberation.system.md
    if (key === 'deliberation') {
      return 'deliberation/deliberation.system.md';
    }
    // doc-generation → doc-generation/doc-internal-writer.system.md
    // doc-generation.X → doc-generation/doc-internal-writer.X.system.md (for writer variants)
    // doc-generation.coherence-review → doc-generation/doc-internal-coherence-review.system.md
    if (key === 'doc-generation.coherence-review') {
      return 'doc-generation/doc-internal-coherence-review.system.md';
    }
    if (key === 'doc-generation.updater') {
      return 'doc-generation/doc-internal-updater.system.md';
    }
    if (key === 'doc-generation.content-review') {
      return 'doc-generation/doc-internal-content-review.system.md';
    }
    if (key.startsWith('doc-generation')) {
      const variant = key.replace('doc-generation', '').replace(/^\./, '');
      return variant
        ? `doc-generation/doc-internal-writer.${variant}.system.md`
        : 'doc-generation/doc-internal-writer.system.md';
    }
    // rag.X → rag/X.system.md (strip rag. prefix)
    if (key.startsWith('rag.')) {
      const sub = key.replace('rag.', '');
      return `rag/${sub}.system.md`;
    }
    // refinement.X → refinement/X.system.md (strip refinement. prefix)
    if (key.startsWith('refinement.')) {
      const sub = key.replace('refinement.', '');
      return `refinement/${sub}.system.md`;
    }
    // _shared.X → _shared/X.system.md (strip _shared. prefix)
    if (key.startsWith('_shared.')) {
      const sub = key.replace('_shared.', '');
      return `_shared/${sub}.system.md`;
    }
    throw new Error(`Unknown key pattern: ${key}`);
  }

  it('AC: no orphan .system.md files — every file has a registry key', () => {
    _resetPromptRegistry();
    const keys = _getRegistryKeys();

    // Build set of expected file paths from all registry keys
    const expectedFiles = new Set(keys.map(keyToExpectedFile));

    // Glob actual .system.md files on disk
    const promptsDir = resolve(import.meta.dirname, '../prompts');
    const mdFiles = globSync('**/*.system.md', { cwd: promptsDir });

    // Precondition: we actually found files (guards against broken path)
    expect(mdFiles.length).toBeGreaterThan(0);

    for (const mdFile of mdFiles) {
      expect(
        expectedFiles.has(mdFile),
        `File "${mdFile}" has no corresponding registry key`,
      ).toBe(true);
    }
  });

  it('AC: no orphan registry keys — every key maps to an existing .system.md file', () => {
    _resetPromptRegistry();
    const keys = _getRegistryKeys();
    const promptsDir = resolve(import.meta.dirname, '../prompts');

    for (const key of keys) {
      const expectedFile = keyToExpectedFile(key);
      const fullPath = resolve(promptsDir, expectedFile);
      expect(
        existsSync(fullPath),
        `Registry key "${key}" expects file "${expectedFile}" but it does not exist`,
      ).toBe(true);
    }
  });

  it('AC: registry snapshot — sorted keys with content lengths', () => {
    _resetPromptRegistry();
    const snapshot = _getRegistrySnapshot();

    // Exact key list snapshot — any addition, removal, or rename will fail this test
    const keys = snapshot.map(([k]) => k);
    expect(keys).toMatchInlineSnapshot(`
      [
        "_shared.guard-rails",
        "_shared.json-evaluator-wrapper",
        "best_practices",
        "best_practices.bash",
        "best_practices.csharp",
        "best_practices.go",
        "best_practices.java",
        "best_practices.json",
        "best_practices.nextjs",
        "best_practices.python",
        "best_practices.react",
        "best_practices.rust",
        "best_practices.sql",
        "best_practices.yaml",
        "correction",
        "correction.verification",
        "deliberation",
        "doc-generation",
        "doc-generation.api-reference",
        "doc-generation.architecture",
        "doc-generation.coherence-review",
        "doc-generation.content-review",
        "doc-generation.updater",
        "documentation",
        "documentation.bash",
        "documentation.csharp",
        "documentation.go",
        "documentation.java",
        "documentation.nextjs",
        "documentation.python",
        "documentation.react",
        "documentation.rust",
        "documentation.sql",
        "documentation.yaml",
        "duplication",
        "overengineering",
        "rag.nlp-summarizer",
        "rag.section-refiner",
        "refinement.tier3-investigation",
        "tests",
        "utility",
      ]
    `);

    // All prompts have non-trivial content
    for (const [key, length] of snapshot) {
      expect(length, `key "${key}" should have substantial content`).toBeGreaterThan(10);
    }
  });

  it('AC: old src/core/axes/prompts/ directory no longer exists', () => {
    const oldDir = resolve(import.meta.dirname, './axes/prompts');
    expect(existsSync(oldDir)).toBe(false);
  });
});
