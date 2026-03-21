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
