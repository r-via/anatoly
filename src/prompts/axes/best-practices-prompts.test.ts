// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeAll } from 'vitest';
import { resolveSystemPrompt, _resetPromptRegistry } from '../../core/prompt-resolver.js';

beforeAll(() => {
  _resetPromptRegistry();
});

/** Count rules in a prompt by matching table rows with rule_id pattern: | N | */
function countRules(prompt: string): number {
  const matches = prompt.match(/^\|\s*\d+\s*\|/gm);
  return matches ? matches.length : 0;
}

describe('best-practices.bash.system.md — ShellGuard', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = resolveSystemPrompt('best_practices', 'bash');
  });

  // AC 31.15.1: min 12 rules
  it('AC 31.15.1: contains at least 12 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(12);
  });

  it('contains ShellGuard identifier', () => {
    expect(prompt).toContain('ShellGuard');
  });

  it('includes set -euo pipefail rule (CRITICAL)', () => {
    expect(prompt).toMatch(/set -euo pipefail/i);
    expect(prompt).toMatch(/set.*pipefail.*CRITICAL/i);
  });

  it('includes quoted variables rule (CRITICAL)', () => {
    expect(prompt).toMatch(/quot.*var/i);
  });

  it('includes no eval rule (HIGH)', () => {
    expect(prompt).toMatch(/eval/i);
  });

  it('specifies same JSON output format as TypeScript prompt', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
    expect(prompt).toContain('"status"');
  });
});

describe('best-practices.python.system.md — PyGuard', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = resolveSystemPrompt('best_practices', 'python');
  });

  // AC 31.15.2: min 13 rules
  it('AC 31.15.2: contains at least 13 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(13);
  });

  it('contains PyGuard identifier', () => {
    expect(prompt).toContain('PyGuard');
  });

  it('includes type hints rule (HIGH)', () => {
    expect(prompt).toMatch(/type hint/i);
  });

  it('includes no bare except rule (CRITICAL)', () => {
    expect(prompt).toMatch(/bare.*except/i);
  });

  it('includes f-strings rule (MEDIUM)', () => {
    expect(prompt).toMatch(/f-string/i);
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
  });
});

describe('best-practices.rust.system.md — RustGuard', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = resolveSystemPrompt('best_practices', 'rust');
  });

  // AC 31.15.3: min 10 rules
  it('AC 31.15.3: contains at least 10 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(10);
  });

  it('contains RustGuard identifier', () => {
    expect(prompt).toContain('RustGuard');
  });

  it('includes no unwrap in prod rule (CRITICAL)', () => {
    expect(prompt).toMatch(/unwrap/i);
  });

  it('includes no unsafe without justification rule (CRITICAL)', () => {
    expect(prompt).toMatch(/unsafe/i);
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
  });
});

describe('best-practices.go.system.md — GoGuard', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = resolveSystemPrompt('best_practices', 'go');
  });

  // AC 31.15.4: min 10 rules
  it('AC 31.15.4: contains at least 10 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(10);
  });

  it('contains GoGuard identifier', () => {
    expect(prompt).toContain('GoGuard');
  });

  it('includes error handling rule (CRITICAL)', () => {
    expect(prompt).toMatch(/error.*handl/i);
  });

  it('includes no panic in prod rule (CRITICAL)', () => {
    expect(prompt).toMatch(/panic/i);
  });

  it('includes context propagation rule (HIGH)', () => {
    expect(prompt).toMatch(/context/i);
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
  });
});

// --- Story 31.16: Java, C#, SQL, YAML, JSON ---

describe('best-practices.java.system.md — JavaGuard', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = resolveSystemPrompt('best_practices', 'java');
  });

  it('AC 31.16.1: contains at least 10 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(10);
  });

  it('contains JavaGuard identifier', () => {
    expect(prompt).toContain('JavaGuard');
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
    expect(prompt).toMatch(/PASS.*WARN.*FAIL/);
  });
});

describe('best-practices.csharp.system.md — CSharpGuard', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = resolveSystemPrompt('best_practices', 'csharp');
  });

  it('AC 31.16.2: contains at least 10 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(10);
  });

  it('contains CSharpGuard identifier', () => {
    expect(prompt).toContain('CSharpGuard');
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
    expect(prompt).toMatch(/PASS.*WARN.*FAIL/);
  });
});

describe('best-practices.sql.system.md — SqlGuard', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = resolveSystemPrompt('best_practices', 'sql');
  });

  it('AC 31.16.3: contains at least 8 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(8);
  });

  it('contains SqlGuard identifier', () => {
    expect(prompt).toContain('SqlGuard');
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
    expect(prompt).toMatch(/PASS.*WARN.*FAIL/);
  });
});

describe('best-practices.yaml.system.md — YamlGuard', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = resolveSystemPrompt('best_practices', 'yaml');
  });

  it('AC 31.16.4: contains at least 8 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(8);
  });

  it('contains YamlGuard identifier', () => {
    expect(prompt).toContain('YamlGuard');
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
    expect(prompt).toMatch(/PASS.*WARN.*FAIL/);
  });
});

describe('best-practices.json.system.md — JsonGuard', () => {
  let prompt: string;

  beforeAll(() => {
    prompt = resolveSystemPrompt('best_practices', 'json');
  });

  it('AC 31.16.5: contains at least 5 rules', () => {
    expect(countRules(prompt)).toBeGreaterThanOrEqual(5);
  });

  it('contains JsonGuard identifier', () => {
    expect(prompt).toContain('JsonGuard');
  });

  it('specifies same JSON output format', () => {
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"rules"');
    expect(prompt).toContain('"rule_id"');
    expect(prompt).toMatch(/PASS.*WARN.*FAIL/);
  });
});

// AC 31.15.5 + 31.16.6: Output format matches BestPracticesResponseSchema for ALL languages
describe('all language prompts use same output schema', () => {
  beforeAll(() => {
    _resetPromptRegistry();
  });

  it('all prompts specify PASS | WARN | FAIL status values', () => {
    for (const lang of ['bash', 'python', 'rust', 'go', 'java', 'csharp', 'sql', 'yaml', 'json']) {
      const prompt = resolveSystemPrompt('best_practices', lang);
      expect(prompt).toMatch(/PASS.*WARN.*FAIL/);
    }
  });

  it('all prompts specify CRITICAL | HIGH | MEDIUM severity values', () => {
    for (const lang of ['bash', 'python', 'rust', 'go', 'java', 'csharp', 'sql', 'yaml', 'json']) {
      const prompt = resolveSystemPrompt('best_practices', lang);
      expect(prompt).toContain('CRITICAL');
      expect(prompt).toContain('HIGH');
      expect(prompt).toContain('MEDIUM');
    }
  });
});
