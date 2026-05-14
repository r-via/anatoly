// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  validateProviderMode,
  detectApiKey,
  buildInitConfig,
  detectDocPaths,
  buildDocumentationConfig,
  LANGUAGE_DOC_KINDS,
  mergeDocumentationIntoYaml,
  type WizardSelections,
  type DocWizardSelections,
} from './init.js';
import type { DocCommentKind } from '../schemas/config.js';

// ---------------------------------------------------------------------------
// validateProviderMode
// ---------------------------------------------------------------------------

describe('validateProviderMode', () => {
  it('allows subscription mode for anthropic', () => {
    expect(validateProviderMode('anthropic', 'subscription')).toBeNull();
  });

  it('allows subscription mode for google', () => {
    expect(validateProviderMode('google', 'subscription')).toBeNull();
  });

  it('rejects subscription mode for other providers', () => {
    expect(validateProviderMode('groq', 'subscription')).toMatch(
      /subscription mode only available/i,
    );
  });

  it('allows api mode for any provider', () => {
    expect(validateProviderMode('groq', 'api')).toBeNull();
    expect(validateProviderMode('anthropic', 'api')).toBeNull();
    expect(validateProviderMode('custom-provider', 'api')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectApiKey
// ---------------------------------------------------------------------------

describe('detectApiKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('detects ANTHROPIC_API_KEY for anthropic', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    expect(detectApiKey('anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('detects GOOGLE_GENERATIVE_AI_API_KEY for google', () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-key');
    expect(detectApiKey('google')).toBe('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('returns null when env var is missing', () => {
    delete process.env.GROQ_API_KEY;
    expect(detectApiKey('groq')).toBeNull();
  });

  it('derives env var name for unknown providers', () => {
    vi.stubEnv('MY_PROVIDER_API_KEY', 'secret');
    expect(detectApiKey('my-provider')).toBe('MY_PROVIDER_API_KEY');
  });
});

// ---------------------------------------------------------------------------
// buildInitConfig
// ---------------------------------------------------------------------------

describe('buildInitConfig', () => {
  it('generates valid v2 config with prefixed model names', () => {
    const selections: WizardSelections = {
      providers: new Map([
        ['anthropic', { mode: 'subscription' }],
        ['google', { mode: 'api' }],
      ]),
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'google/gemini-2.5-flash-lite',
        deliberation: 'anthropic/claude-opus-4-6',
      },
    };

    const config = buildInitConfig(selections);

    expect(config.providers.anthropic).toEqual({ mode: 'subscription' });
    expect(config.providers.google).toEqual({ mode: 'api' });
    expect(config.models.quality).toBe('anthropic/claude-sonnet-4-6');
    expect(config.models.fast).toBe('google/gemini-2.5-flash-lite');
    expect(config.models.deliberation).toBe('anthropic/claude-opus-4-6');
  });

  it('includes code_summary when provided', () => {
    const selections: WizardSelections = {
      providers: new Map([['anthropic', { mode: 'subscription' }]]),
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5-20251001',
        deliberation: 'anthropic/claude-opus-4-6',
        code_summary: 'anthropic/claude-haiku-4-5-20251001',
      },
    };

    const config = buildInitConfig(selections);
    expect(config.models.code_summary).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  it('includes split modes when present', () => {
    const selections: WizardSelections = {
      providers: new Map([
        ['anthropic', { mode: 'subscription', single_turn: 'subscription', agents: 'api' }],
      ]),
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5-20251001',
        deliberation: 'anthropic/claude-opus-4-6',
      },
    };

    const config = buildInitConfig(selections);
    expect(config.providers.anthropic).toEqual({
      mode: 'subscription',
      single_turn: 'subscription',
      agents: 'api',
    });
  });
});

// ---------------------------------------------------------------------------
// Story 54.2: detectDocPaths — filesystem auto-detection
// ---------------------------------------------------------------------------

describe('detectDocPaths', () => {
  const TMP = join(import.meta.dirname ?? '.', '__test_init_docpaths__');

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('detects docs/ directory when present', () => {
    mkdirSync(join(TMP, 'docs'), { recursive: true });
    writeFileSync(join(TMP, 'docs', 'index.md'), '# Docs');
    const result = detectDocPaths(TMP);
    expect(result).toContain('docs/**/*.md');
  });

  it('detects README.md when present', () => {
    writeFileSync(join(TMP, 'README.md'), '# Hello');
    const result = detectDocPaths(TMP);
    expect(result).toContain('README.md');
  });

  it('detects ARCHITECTURE.md when present', () => {
    writeFileSync(join(TMP, 'ARCHITECTURE.md'), '# Arch');
    const result = detectDocPaths(TMP);
    expect(result).toContain('ARCHITECTURE.md');
  });

  it('detects CONTRIBUTING.md when present', () => {
    writeFileSync(join(TMP, 'CONTRIBUTING.md'), '# Contributing');
    const result = detectDocPaths(TMP);
    expect(result).toContain('CONTRIBUTING.md');
  });

  it('detects specs/ directory when present', () => {
    mkdirSync(join(TMP, 'specs'), { recursive: true });
    writeFileSync(join(TMP, 'specs', 'prd.md'), '# PRD');
    const result = detectDocPaths(TMP);
    expect(result).toContain('specs/**/*.md');
  });

  it('returns empty array when no doc paths found', () => {
    const result = detectDocPaths(TMP);
    expect(result).toEqual([]);
  });

  it('returns multiple detected paths', () => {
    writeFileSync(join(TMP, 'README.md'), '# Hello');
    mkdirSync(join(TMP, 'docs'), { recursive: true });
    writeFileSync(join(TMP, 'docs', 'api.md'), '# API');
    const result = detectDocPaths(TMP);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result).toContain('README.md');
    expect(result).toContain('docs/**/*.md');
  });
});

// ---------------------------------------------------------------------------
// Story 54.2: LANGUAGE_DOC_KINDS mapping
// ---------------------------------------------------------------------------

describe('LANGUAGE_DOC_KINDS', () => {
  it('maps TypeScript to jsdoc and tsdoc', () => {
    expect(LANGUAGE_DOC_KINDS.TypeScript).toContain('jsdoc');
    expect(LANGUAGE_DOC_KINDS.TypeScript).toContain('tsdoc');
  });

  it('maps Python to docstring', () => {
    expect(LANGUAGE_DOC_KINDS.Python).toContain('docstring');
  });

  it('maps Go to godoc', () => {
    expect(LANGUAGE_DOC_KINDS.Go).toContain('godoc');
  });

  it('maps Java to javadoc', () => {
    expect(LANGUAGE_DOC_KINDS.Java).toContain('javadoc');
  });

  it('maps C# to xmldoc', () => {
    expect(LANGUAGE_DOC_KINDS['C#']).toContain('xmldoc');
  });

  it('maps Shell to module_header', () => {
    expect(LANGUAGE_DOC_KINDS.Shell).toContain('module_header');
  });

  it('maps Rust to module_header', () => {
    expect(LANGUAGE_DOC_KINDS.Rust).toContain('module_header');
  });
});

// ---------------------------------------------------------------------------
// Story 54.2: buildDocumentationConfig
// ---------------------------------------------------------------------------

describe('buildDocumentationConfig', () => {
  it('builds off mode config', () => {
    const selections: DocWizardSelections = {
      referencePaths: ['docs/**/*.md', 'README.md'],
      inlineCommentsEnabled: false,
      internalMode: 'off',
    };
    const config = buildDocumentationConfig(selections);
    expect(config.reference.paths).toEqual(['docs/**/*.md', 'README.md']);
    expect(config.reference.inline_comments.enabled).toBe(false);
    expect(config.internal.mode).toBe('off');
    expect(config.internal.lite).toBeUndefined();
    expect(config.internal.full).toBeUndefined();
  });

  it('builds lite mode config with default max_tokens', () => {
    const selections: DocWizardSelections = {
      referencePaths: ['README.md'],
      inlineCommentsEnabled: false,
      internalMode: 'lite',
    };
    const config = buildDocumentationConfig(selections);
    expect(config.internal.mode).toBe('lite');
    expect(config.internal.lite).toBeDefined();
    expect(config.internal.lite!.max_tokens).toBe(12000);
    expect(config.internal.lite!.refresh_on).toEqual(['code_change']);
    expect(config.internal.lite!.on_overflow).toBe('warn');
  });

  it('builds full mode config', () => {
    const selections: DocWizardSelections = {
      referencePaths: ['README.md'],
      inlineCommentsEnabled: false,
      internalMode: 'full',
    };
    const config = buildDocumentationConfig(selections);
    expect(config.internal.mode).toBe('full');
    expect(config.internal.full).toBeDefined();
    expect(config.internal.full!.sync_to_repo).toBe(false);
  });

  it('includes inline_comments kinds and include when enabled', () => {
    const selections: DocWizardSelections = {
      referencePaths: ['README.md'],
      inlineCommentsEnabled: true,
      inlineCommentKinds: ['jsdoc', 'tsdoc'],
      inlineCommentInclude: ['src/**/*.ts'],
      internalMode: 'off',
    };
    const config = buildDocumentationConfig(selections);
    expect(config.reference.inline_comments.enabled).toBe(true);
    expect(config.reference.inline_comments.kinds).toEqual(['jsdoc', 'tsdoc']);
    expect(config.reference.inline_comments.include).toEqual(['src/**/*.ts']);
  });
});

// ---------------------------------------------------------------------------
// Story 54.2: mergeDocumentationIntoYaml — --reconfigure-docs
// ---------------------------------------------------------------------------

describe('mergeDocumentationIntoYaml', () => {
  it('replaces the documentation section preserving everything else', () => {
    const existingYaml = `providers:
  anthropic:
    mode: subscription
models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5-20251001
  deliberation: anthropic/claude-opus-4-6
documentation:
  reference:
    paths:
      - README.md
    inline_comments:
      enabled: false
  internal:
    mode: 'off'
`;
    const newDocConfig = {
      reference: {
        paths: ['docs/**/*.md', 'README.md'],
        inline_comments: { enabled: true, kinds: ['jsdoc'] as DocCommentKind[], include: ['src/**/*.ts'] },
      },
      internal: { mode: 'lite' as const, lite: { max_tokens: 12000, refresh_on: ['code_change'] as ('code_change' | 'schema_change' | 'manual')[], on_overflow: 'warn' as const } },
    };
    const result = mergeDocumentationIntoYaml(existingYaml, newDocConfig);
    // Parse the result to verify structure
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed.providers).toBeDefined();
    expect(parsed.models).toBeDefined();
    const doc = parsed.documentation as Record<string, unknown>;
    expect(doc).toBeDefined();
    const ref = doc.reference as Record<string, unknown>;
    expect((ref.paths as string[])).toContain('docs/**/*.md');
    const int = doc.internal as Record<string, unknown>;
    expect(int.mode).toBe('lite');
  });

  it('adds documentation section when absent', () => {
    const existingYaml = `providers:
  anthropic:
    mode: subscription
models:
  quality: anthropic/claude-sonnet-4-6
`;
    const newDocConfig = {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: { mode: 'off' as const },
    };
    const result = mergeDocumentationIntoYaml(existingYaml, newDocConfig);
    const parsed = yaml.load(result) as Record<string, unknown>;
    expect(parsed.documentation).toBeDefined();
    expect(parsed.providers).toBeDefined();
  });

  it('preserves non-documentation sections', () => {
    const existingYaml = `providers:
  anthropic:
    mode: subscription
    concurrency: 24
models:
  quality: anthropic/claude-sonnet-4-6
  fast: anthropic/claude-haiku-4-5-20251001
  deliberation: anthropic/claude-opus-4-6
`;
    const docConfig = {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: { mode: 'off' as const },
    };
    const result = mergeDocumentationIntoYaml(existingYaml, docConfig);
    const parsed = yaml.load(result) as Record<string, unknown>;
    const providers = parsed.providers as Record<string, unknown>;
    const anthropic = providers.anthropic as Record<string, unknown>;
    expect(anthropic.mode).toBe('subscription');
    expect(anthropic.concurrency).toBe(24);
  });

  it('includes date comment header for documentation section', () => {
    const existingYaml = `providers:
  anthropic:
    mode: subscription
`;
    const docConfig = {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: { mode: 'off' as const },
    };
    const result = mergeDocumentationIntoYaml(existingYaml, docConfig);
    expect(result).toContain('# Generated by anatoly init');
    expect(result).toContain('anatoly init --reconfigure-docs');
  });

  it('produces identical output on consecutive calls with same input (NFR7)', () => {
    const existingYaml = `providers:
  anthropic:
    mode: subscription
`;
    const docConfig = {
      reference: { paths: ['README.md'], inline_comments: { enabled: false } },
      internal: { mode: 'off' as const },
    };
    const result1 = mergeDocumentationIntoYaml(existingYaml, docConfig);
    const result2 = mergeDocumentationIntoYaml(existingYaml, docConfig);
    expect(result1).toBe(result2);
  });
});
