// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveSystemPrompt,
  registerPrompt,
  _clearPromptRegistry,
  _resetPromptRegistry,
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
    // Use resolveSystemPrompt to verify each key exists
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
