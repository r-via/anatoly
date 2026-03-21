// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeAll } from 'vitest';
import { resolveSystemPrompt, _resetPromptRegistry } from '../../prompt-resolver.js';

beforeAll(() => {
  _resetPromptRegistry();
});

/** Count rules in a prompt by matching table rows with rule_id pattern: | N | */
function countRules(prompt: string): number {
  const matches = prompt.match(/^\|\s*\d+\s*\|/gm);
  return matches ? matches.length : 0;
}

// --- Best Practices ---

// AC 31.18.1: React best-practices prompt
describe('best-practices.react.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('best_practices', 'typescript', 'react'); });

  it('AC 31.18.1: contains at least 12 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(12);
  });

  it('includes hooks rules', () => {
    expect(prompt).toMatch(/hooks/i);
  });

  it('includes memo/useMemo/useCallback', () => {
    expect(prompt).toMatch(/memo/i);
  });

  it('includes accessibility (a11y)', () => {
    expect(prompt).toMatch(/a11y|accessib/i);
  });

  it('includes key prop rule', () => {
    expect(prompt).toMatch(/key prop/i);
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
    expect(prompt).toMatch(/PASS.*WARN.*FAIL/);
  });
});

// AC 31.18.2: Next.js best-practices prompt
describe('best-practices.nextjs.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('best_practices', 'typescript', 'nextjs'); });

  it('AC 31.18.2: contains at least 12 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(12);
  });

  it('includes use client / use server directives', () => {
    expect(prompt).toMatch(/use client/i);
    expect(prompt).toMatch(/use server/i);
  });

  it('includes App Router', () => {
    expect(prompt).toMatch(/App Router/i);
  });

  it('includes generateMetadata', () => {
    expect(prompt).toContain('generateMetadata');
  });

  it('includes server component data fetching', () => {
    expect(prompt).toMatch(/server component/i);
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
    expect(prompt).toMatch(/PASS.*WARN.*FAIL/);
  });
});

// --- Documentation ---

// AC 31.18.3: React documentation prompt
describe('documentation.react.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'typescript', 'react'); });

  it('AC 31.18.3: evaluates props interface as documentation', () => {
    expect(prompt).toMatch(/props.*interface|interface.*props/i);
  });

  it('evaluates component JSDoc', () => {
    expect(prompt).toMatch(/JSDoc|component.*doc/i);
  });

  it('mentions Storybook', () => {
    expect(prompt).toMatch(/Storybook/i);
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// AC 31.18.4: Next.js documentation prompt
describe('documentation.nextjs.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'typescript', 'nextjs'); });

  it('AC 31.18.4: evaluates route documentation', () => {
    expect(prompt).toMatch(/route/i);
  });

  it('evaluates API Route documentation', () => {
    expect(prompt).toMatch(/API.*Route/i);
  });

  it('evaluates middleware documentation', () => {
    expect(prompt).toMatch(/middleware/i);
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// --- Cascade behavior ---

// AC 31.18.5: .tsx in Next.js → Next.js prompt, NOT TypeGuard
describe('cascade: framework overrides language', () => {
  it('AC 31.18.5: tsx in Next.js uses nextjs prompt, not TypeGuard', () => {
    _resetPromptRegistry();
    const prompt = resolveSystemPrompt('best_practices', 'typescript', 'nextjs');
    // Should NOT be the default TypeGuard prompt
    expect(prompt).not.toContain('TypeGuard');
    // Should be the Next.js prompt
    expect(prompt).toContain('Next.js');
  });

  // AC 31.18.6: .ts (non-JSX) in Next.js → still Next.js prompt
  it('AC 31.18.6: ts in Next.js still uses nextjs prompt', () => {
    _resetPromptRegistry();
    // Same call — framework is 'nextjs' regardless of JSX
    const prompt = resolveSystemPrompt('best_practices', 'typescript', 'nextjs');
    expect(prompt).toContain('Next.js');
    expect(prompt).not.toContain('TypeGuard');
  });
});
