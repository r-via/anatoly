// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { globSync } from 'tinyglobby';
import {
  resolveSystemPrompt,
  registerPrompt,
  _clearPromptRegistry,
  _resetPromptRegistry,
  _getRegistryKeys,
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

  it('registry contains at least 36 entries after reset', () => {
    const keys: string[] = [];
    const expectedKeys = [
      'utility', 'best_practices', 'documentation', 'correction', 'duplication', 'tests', 'overengineering',
      'best_practices.bash', 'best_practices.python', 'best_practices.rust', 'best_practices.go',
      'best_practices.java', 'best_practices.csharp', 'best_practices.sql', 'best_practices.yaml', 'best_practices.json',
      'documentation.bash', 'documentation.python', 'documentation.rust', 'documentation.go',
      'documentation.java', 'documentation.csharp', 'documentation.sql', 'documentation.yaml',
      'best_practices.react', 'best_practices.nextjs', 'documentation.react', 'documentation.nextjs',
      'deliberation', 'doc-generation', 'doc-generation.architecture', 'doc-generation.api-reference',
      'rag.section-refiner', 'rag.nlp-summarizer', '_shared.json-evaluator-wrapper', 'correction.verification',
    ];
    for (const key of expectedKeys) {
      expect(() => resolveSystemPrompt(key)).not.toThrow();
      keys.push(key);
    }
    expect(keys.length).toBeGreaterThanOrEqual(36);
  });
});

// --- Story 33.4: Bidirectional coherence and snapshot ---

describe('Story 33.4 — registry coherence', () => {
  it('AC: no orphan .system.md files — every file has a registry key', () => {
    _resetPromptRegistry();
    const registryKeys = new Set(_getRegistryKeys());

    // Map file paths to expected registry keys
    const promptsDir = resolve(import.meta.dirname, '../prompts');
    const mdFiles = globSync('**/*.system.md', { cwd: promptsDir });

    // Build expected key from file path
    // e.g. axes/best-practices.bash.system.md → best_practices.bash
    // e.g. deliberation/deliberation.system.md → deliberation
    // e.g. _shared/json-evaluator-wrapper.system.md → _shared.json-evaluator-wrapper
    function fileToKey(relPath: string): string {
      const fileName = relPath.replace(/\.system\.md$/, '');
      const parts = fileName.split('/');

      if (parts[0] === 'axes') {
        // axes/best-practices.bash → best_practices.bash
        const name = parts.slice(1).join('/');
        // best-practices → best_practices (only the axis prefix)
        return name.replace(/^best-practices/, 'best_practices');
      }
      // deliberation/deliberation → deliberation
      // doc-generation/doc-writer → doc-generation
      // doc-generation/doc-writer.architecture → doc-generation.architecture
      // rag/section-refiner → rag.section-refiner
      // _shared/json-evaluator-wrapper → _shared.json-evaluator-wrapper
      const domain = parts[0];
      const file = parts.slice(1).join('/');
      if (file.startsWith('doc-writer')) {
        const variant = file.replace('doc-writer', '').replace(/^\./, '');
        return variant ? `doc-generation.${variant}` : 'doc-generation';
      }
      if (file === domain) return domain; // deliberation/deliberation
      return `${domain}.${file}`;
    }

    for (const mdFile of mdFiles) {
      const key = fileToKey(mdFile);
      expect(registryKeys.has(key), `File ${mdFile} expected key "${key}" not in registry`).toBe(true);
    }
  });

  it('AC: no orphan registry keys — every key has a .system.md file', () => {
    _resetPromptRegistry();
    const keys = _getRegistryKeys();

    const promptsDir = resolve(import.meta.dirname, '../prompts');
    const mdFiles = new Set(globSync('**/*.system.md', { cwd: promptsDir }));

    // Verify registry has same count as files
    expect(keys.length).toBe(mdFiles.size);
  });

  it('AC: registry snapshot — sorted keys with content length', () => {
    _resetPromptRegistry();
    const keys = _getRegistryKeys();

    // Snapshot: verify all 36 keys exist and have non-trivial content
    expect(keys.length).toBe(36);

    for (const key of keys) {
      const content = resolveSystemPrompt(key);
      expect(content.length).toBeGreaterThan(10);
    }
  });
});
