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
  mergeScanIntoYaml,
  ensureCommandsInYaml,
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
        ['groq', { mode: 'api' }],
      ]),
      models: {
        quality: 'anthropic/claude-sonnet-4-6',
        fast: 'anthropic/claude-haiku-4-5',
        deliberation: 'anthropic/claude-opus-4-6',
      },
    };

    const config = buildInitConfig(selections);

    expect(config.providers.anthropic).toEqual({ mode: 'subscription' });
    expect(config.providers.groq).toEqual({ mode: 'api' });
    expect(config.models.quality).toBe('anthropic/claude-sonnet-4-6');
    expect(config.models.fast).toBe('anthropic/claude-haiku-4-5');
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
    expect(config.internal.full).toBeUndefined();
  });

  it('builds lite mode config with no sub-block (per-file RAG retrieval)', () => {
    const selections: DocWizardSelections = {
      referencePaths: ['README.md'],
      inlineCommentsEnabled: false,
      internalMode: 'lite',
    };
    const config = buildDocumentationConfig(selections);
    expect(config.internal.mode).toBe('lite');
    expect(config.internal.full).toBeUndefined();
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

// ---------------------------------------------------------------------------
// mergeScanIntoYaml — `init --phases scope`
// (docs/02-Architecture/21-Scope-Reconfiguration-Phase.md §3.3)
// ---------------------------------------------------------------------------

describe('mergeScanIntoYaml', () => {
  const base = `scan:
  include:
    - src/**/*.ts
  exclude:
    - node_modules/**   # vendored
    - dist/**
  respect_gitignore: true
providers:
  anthropic:
    mode: subscription
`;

  it('unions new globs into scan.exclude and dedupes against existing', () => {
    const result = mergeScanIntoYaml(base, ['dist/**', 'src/__fixtures__/**']);
    const parsed = yaml.load(result) as { scan: { exclude: string[] } };
    const ex = parsed.scan.exclude;
    // existing kept, no duplicate for dist, new one appended
    expect(ex.filter((g) => g === 'dist/**')).toHaveLength(1);
    expect(ex).toContain('node_modules/**');
    expect(ex).toContain('src/__fixtures__/**');
  });

  it('touches only scan.exclude — other sections and keys are preserved', () => {
    const result = mergeScanIntoYaml(base, ['src/__fixtures__/**']);
    const parsed = yaml.load(result) as {
      providers: { anthropic: { mode: string } };
      scan: { include: string[]; respect_gitignore: boolean };
    };
    expect(parsed.providers.anthropic.mode).toBe('subscription');
    expect(parsed.scan.include).toEqual(['src/**/*.ts']);
    expect(parsed.scan.respect_gitignore).toBe(true);
  });

  it('preserves existing comments (surgical, not a re-dump)', () => {
    const result = mergeScanIntoYaml(base, ['src/__fixtures__/**']);
    expect(result).toContain('# vendored');
  });

  it('stamps new entries with a dated origin comment', () => {
    const result = mergeScanIntoYaml(base, ['src/__fixtures__/**'], { dateStamp: '2026-05-30' });
    expect(result).toContain('src/__fixtures__/** # added by anatoly init --phases scope on 2026-05-30');
  });

  it('never deletes hand-added entries', () => {
    const result = mergeScanIntoYaml(base, ['new/**']);
    const parsed = yaml.load(result) as { scan: { exclude: string[] } };
    expect(parsed.scan.exclude).toContain('node_modules/**');
    expect(parsed.scan.exclude).toContain('dist/**');
  });

  it('is idempotent: returns input verbatim when nothing is new', () => {
    expect(mergeScanIntoYaml(base, ['dist/**', 'node_modules/**'])).toBe(base);
    expect(mergeScanIntoYaml(base, [])).toBe(base);
  });

  it('re-running the merged output adds nothing', () => {
    const once = mergeScanIntoYaml(base, ['src/__fixtures__/**'], { dateStamp: '2026-05-30' });
    const twice = mergeScanIntoYaml(once, ['src/__fixtures__/**'], { dateStamp: '2026-05-30' });
    expect(twice).toBe(once);
  });

  it('creates scan.exclude when the section is absent', () => {
    const noScan = `providers:\n  anthropic:\n    mode: subscription\n`;
    const result = mergeScanIntoYaml(noScan, ['src/__fixtures__/**']);
    const parsed = yaml.load(result) as { scan: { exclude: string[] } };
    expect(parsed.scan.exclude).toContain('src/__fixtures__/**');
    expect((yaml.load(result) as { providers?: unknown }).providers).toBeDefined();
  });

  it('unions opts.vendored into scan.vendored (audited but best-practices-limited)', () => {
    const result = mergeScanIntoYaml(base, ['src/__fixtures__/**'], { vendored: ['**/components/ui/**'] });
    const parsed = yaml.load(result) as { scan: { exclude: string[]; vendored: string[] } };
    expect(parsed.scan.exclude).toContain('src/__fixtures__/**');
    expect(parsed.scan.vendored).toEqual(['**/components/ui/**']);
  });

  it('creates scan.vendored when only vendored globs are supplied', () => {
    const result = mergeScanIntoYaml(base, [], { vendored: ['**/components/ui/**'], dateStamp: '2026-05-30' });
    const parsed = yaml.load(result) as { scan: { exclude: string[]; vendored: string[] } };
    expect(parsed.scan.vendored).toContain('**/components/ui/**');
    // exclude untouched
    expect(parsed.scan.exclude).toEqual(['node_modules/**', 'dist/**']);
    // new vendored entry carries the dated origin stamp (glob may be YAML-quoted)
    expect(result).toContain('# added by anatoly init --phases scope on 2026-05-30');
  });

  it('is idempotent across both lists (re-running adds nothing)', () => {
    const once = mergeScanIntoYaml(base, ['src/__fixtures__/**'], { vendored: ['**/components/ui/**'], dateStamp: '2026-05-30' });
    const twice = mergeScanIntoYaml(once, ['src/__fixtures__/**'], { vendored: ['**/components/ui/**'], dateStamp: '2026-05-30' });
    expect(twice).toBe(once);
    // verbatim no-op when nothing new in either list
    expect(mergeScanIntoYaml(base, [], { vendored: [] })).toBe(base);
  });
});

describe('ensureCommandsInYaml', () => {
  const cmds = { model: 'anthropic/q', scope: 'anthropic/s', refresh: 'anthropic/r' };

  it('materializes the commands section when absent', () => {
    const yamlStr = `providers:\n  anthropic:\n    mode: subscription\n`;
    const result = ensureCommandsInYaml(yamlStr, cmds);
    const parsed = yaml.load(result) as { commands: typeof cmds; providers?: unknown };
    expect(parsed.commands).toEqual(cmds);
    expect(parsed.providers).toBeDefined();
  });

  it('never overwrites an existing commands section', () => {
    const yamlStr = `commands:\n  model: anthropic/keep\nproviders: {}\n`;
    const result = ensureCommandsInYaml(yamlStr, cmds);
    expect(result).toBe(yamlStr);
    expect((yaml.load(result) as { commands: { model: string } }).commands.model).toBe('anthropic/keep');
  });

  it('is idempotent after materializing', () => {
    const yamlStr = `providers: {}\n`;
    const once = ensureCommandsInYaml(yamlStr, cmds, { dateStamp: '2026-06-01' });
    const twice = ensureCommandsInYaml(once, cmds, { dateStamp: '2026-06-01' });
    expect(twice).toBe(once);
  });
});
