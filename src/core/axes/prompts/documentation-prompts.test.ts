// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeAll } from 'vitest';
import { resolveSystemPrompt, _resetPromptRegistry } from '../../prompt-resolver.js';

beforeAll(() => {
  _resetPromptRegistry();
});

// AC 31.17.1: Bash documentation prompt
describe('documentation.bash.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'bash'); });

  it('evaluates function header comments', () => {
    expect(prompt).toMatch(/header comment/i);
  });

  it('evaluates # @description annotations', () => {
    expect(prompt).toMatch(/@description/i);
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// AC 31.17.2: Python documentation prompt
describe('documentation.python.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'python'); });

  it('evaluates docstrings', () => {
    expect(prompt).toMatch(/docstring/i);
  });

  it('mentions Google/NumPy/Sphinx styles', () => {
    expect(prompt).toMatch(/Google|NumPy|Sphinx/i);
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// AC 31.17.3: Rust documentation prompt
describe('documentation.rust.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'rust'); });

  it('evaluates /// doc comments', () => {
    expect(prompt).toContain('///');
  });

  it('evaluates # Examples sections', () => {
    expect(prompt).toMatch(/# Examples/i);
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// AC 31.17.4: Go documentation prompt
describe('documentation.go.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'go'); });

  it('evaluates Godoc format', () => {
    expect(prompt).toMatch(/Godoc/i);
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// AC 31.17.5: Java documentation prompt
describe('documentation.java.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'java'); });

  it('evaluates Javadoc', () => {
    expect(prompt).toMatch(/Javadoc/i);
  });

  it('mentions @param, @return, @throws', () => {
    expect(prompt).toContain('@param');
    expect(prompt).toContain('@return');
    expect(prompt).toContain('@throws');
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// AC 31.17.6: C# documentation prompt
describe('documentation.csharp.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'csharp'); });

  it('evaluates XML doc comments', () => {
    expect(prompt).toMatch(/XML doc/i);
  });

  it('mentions <summary> and <param> tags', () => {
    expect(prompt).toContain('<summary>');
    expect(prompt).toContain('<param');
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// AC 31.17.7: SQL documentation prompt
describe('documentation.sql.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'sql'); });

  it('evaluates -- comments on tables/columns', () => {
    expect(prompt).toContain('--');
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// AC 31.17.8: YAML documentation prompt
describe('documentation.yaml.system.md', () => {
  let prompt: string;
  beforeAll(() => { prompt = resolveSystemPrompt('documentation', 'yaml'); });

  it('evaluates # comments on keys', () => {
    expect(prompt).toMatch(/#.*comment/i);
  });

  it('uses same output schema', () => {
    expect(prompt).toContain('"symbols"');
    expect(prompt).toContain('"documentation"');
    expect(prompt).toMatch(/DOCUMENTED.*PARTIAL.*UNDOCUMENTED/);
  });
});

// AC 31.17.9: JSON files — no documentation prompt (skip)
describe('documentation for JSON files', () => {
  it('AC 31.17.9: no JSON-specific documentation prompt registered', () => {
    _resetPromptRegistry();
    // JSON should fall back to default (TypeScript) documentation prompt
    // The axis code handles JSON skip logic, not the prompt
    const prompt = resolveSystemPrompt('documentation', 'json');
    // Should be the default documentation prompt (contains JSDoc references)
    expect(prompt).toContain('JSDoc');
  });
});

// AC 31.17.10: All prompts match DocumentationResponseSchema
describe('all documentation prompts use same output schema', () => {
  it('all prompts specify DOCUMENTED | PARTIAL | UNDOCUMENTED', () => {
    _resetPromptRegistry();
    for (const lang of ['bash', 'python', 'rust', 'go', 'java', 'csharp', 'sql', 'yaml']) {
      const prompt = resolveSystemPrompt('documentation', lang);
      expect(prompt).toMatch(/DOCUMENTED/);
      expect(prompt).toMatch(/PARTIAL/);
      expect(prompt).toMatch(/UNDOCUMENTED/);
    }
  });

  it('all prompts include confidence field', () => {
    _resetPromptRegistry();
    for (const lang of ['bash', 'python', 'rust', 'go', 'java', 'csharp', 'sql', 'yaml']) {
      const prompt = resolveSystemPrompt('documentation', lang);
      expect(prompt).toContain('"confidence"');
    }
  });
});
