// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { loadConfig, migrateConfigV0toV1 } from './config-loader.js';
import { AnatolyError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return defaults when no config file exists', () => {
    const config = loadConfig(tempDir);
    expect(config.project.monorepo).toBe(false);
    expect(config.scan.include).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
    expect(config.scan.exclude).toContain('node_modules/**');
    expect(config.coverage.enabled).toBe(true);
    expect(config.runtime.timeout_per_file).toBe(600);
    expect(config.runtime.max_retries).toBe(3);
  });

  it('should parse a valid .anatoly.yml with legacy llm section', () => {
    const yml = `
project:
  name: my-project
  monorepo: true
scan:
  include:
    - "packages/*/src/**/*.ts"
  exclude:
    - "node_modules/**"
llm:
  model: claude-opus-4-20250514
  timeout_per_file: 300
`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    const config = loadConfig(tempDir);
    expect(config.project.name).toBe('my-project');
    expect(config.project.monorepo).toBe(true);
    expect(config.scan.include).toEqual(['packages/*/src/**/*.ts']);
    // After migration: llm.model → models.quality, llm.timeout_per_file → runtime.timeout_per_file
    expect(config.models.quality).toBe('claude-opus-4-20250514');
    expect(config.runtime.timeout_per_file).toBe(300);
    expect(config.coverage.enabled).toBe(true);
  });

  it('should accept a custom config path', () => {
    const customPath = join(tempDir, 'custom-config.yml');
    writeFileSync(customPath, 'project:\n  name: custom\n');
    const config = loadConfig(tempDir, customPath);
    expect(config.project.name).toBe('custom');
  });

  it('should return defaults for an empty YAML file', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), '');
    const config = loadConfig(tempDir);
    expect(config.project.monorepo).toBe(false);
    expect(config.runtime.max_retries).toBe(3);
  });

  it('should throw CONFIG_INVALID for malformed YAML', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), '  bad:\n- yaml: [unclosed');
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
    try {
      loadConfig(tempDir);
    } catch (err) {
      expect(err).toBeInstanceOf(AnatolyError);
      expect((err as AnatolyError).code).toBe('CONFIG_INVALID');
      expect((err as AnatolyError).recoverable).toBe(false);
    }
  });

  it('should throw CONFIG_INVALID for invalid config values', () => {
    // runtime.timeout_per_file: 0 is invalid (min 1)
    writeFileSync(join(tempDir, '.anatoly.yml'), 'runtime:\n  timeout_per_file: 0\n');
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
    try {
      loadConfig(tempDir);
    } catch (err) {
      expect(err).toBeInstanceOf(AnatolyError);
      expect((err as AnatolyError).code).toBe('CONFIG_INVALID');
    }
  });

  it('should throw CONFIG_INVALID for non-object YAML content', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), '"just a string"');
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
  });

  it('should emit stderr warning for legacy llm format', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const yml = `llm:\n  model: claude-sonnet-4-6\n`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    loadConfig(tempDir);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('legacy');
    expect(output).toContain('llm');
    stderrSpy.mockRestore();
  });

  it('should NOT emit warning for new v1.0 format', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const yml = `models:\n  quality: claude-sonnet-4-6\n`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    loadConfig(tempDir);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).not.toContain('legacy');
    stderrSpy.mockRestore();
  });

  it('should load v1.0 config without providers.google (Gemini disabled, no undefined errors)', () => {
    const yml = `
models:
  quality: claude-sonnet-4-6
  fast: claude-haiku-4-5-20251001
providers:
  anthropic:
    concurrency: 24
runtime:
  concurrency: 8
`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    const config = loadConfig(tempDir);
    expect(config.providers.google).toBeUndefined();
    expect(config.models.quality).toBe('claude-sonnet-4-6');
    expect(config.models.fast).toBe('claude-haiku-4-5-20251001');
    expect(config.providers.anthropic!.concurrency).toBe(24);
    expect(config.models.code_summary).toBeUndefined();
  });

  it('should load the project anatoly.yml without warnings or errors', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Load from the actual project root
    const projectRoot = join(__dirname, '..', '..');
    const config = loadConfig(projectRoot);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).not.toContain('legacy');
    expect(config.providers.anthropic!.concurrency).toBe(24);
    expect(config.providers.google?.mode).toBe('subscription');
    stderrSpy.mockRestore();
  });

  it('should parse a v1.0 config with new sections directly', () => {
    const yml = `
models:
  quality: claude-opus-4-6
  fast: claude-haiku-4-5-20251001
providers:
  anthropic:
    concurrency: 16
  google:
    mode: api
    concurrency: 8
runtime:
  timeout_per_file: 300
  concurrency: 4
agents:
  enabled: true
  deliberation: custom-model
axes:
  correction:
    model: claude-opus-4-6
`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    const config = loadConfig(tempDir);
    expect(config.models.quality).toBe('claude-opus-4-6');
    expect(config.providers.anthropic!.concurrency).toBe(16);
    expect(config.providers.google?.mode).toBe('api');
    expect(config.providers.google?.concurrency).toBe(8);
    expect(config.runtime.timeout_per_file).toBe(300);
    expect(config.agents.deliberation).toBe('custom-model');
    expect(config.axes.correction.model).toBe('claude-opus-4-6');
  });
});

describe('migrateConfigV0toV1', () => {
  it('should return new-format objects unchanged', () => {
    const input = { models: { quality: 'claude-opus-4-6' }, runtime: { concurrency: 4 } };
    const result = migrateConfigV0toV1(input);
    expect(result).toEqual(input);
  });

  it('should not migrate when models key already exists', () => {
    const input = { models: { quality: 'x' }, llm: { model: 'y' } };
    const result = migrateConfigV0toV1(input);
    // Has models → no migration, llm is kept as-is
    expect(result).toEqual(input);
  });

  it('should migrate basic llm fields to new sections', () => {
    const input = {
      llm: {
        model: 'claude-opus-4-6',
        index_model: 'claude-haiku-4-5-20251001',
        deliberation_model: 'custom-deliberation',
        sdk_concurrency: 16,
        timeout_per_file: 300,
        max_retries: 5,
        concurrency: 4,
        min_confidence: 80,
        max_stop_iterations: 2,
        deliberation: false,
      },
    };
    const result = migrateConfigV0toV1(input);

    expect(result.models).toEqual({
      quality: 'claude-opus-4-6',
      fast: 'claude-haiku-4-5-20251001',
      deliberation: 'custom-deliberation',
    });
    expect(result.providers).toEqual({
      anthropic: { concurrency: 16 },
    });
    expect(result.runtime).toEqual({
      timeout_per_file: 300,
      max_retries: 5,
      concurrency: 4,
      min_confidence: 80,
      max_stop_iterations: 2,
    });
    expect(result.agents).toEqual({
      enabled: false,
    });
    expect(result).not.toHaveProperty('llm');
  });

  it('should use fast_model as fallback for models.fast', () => {
    const input = {
      llm: {
        index_model: 'haiku-default',
        fast_model: 'fast-override',
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.models.fast).toBe('fast-override');
  });

  it('should prefer index_model when fast_model is absent', () => {
    const input = {
      llm: {
        index_model: 'haiku-model',
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.models.fast).toBe('haiku-model');
  });

  it('should migrate axes from llm.axes to top-level axes', () => {
    const input = {
      llm: {
        axes: {
          correction: { model: 'claude-opus-4-6', enabled: true },
          utility: { enabled: false },
        },
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.axes).toEqual({
      correction: { model: 'claude-opus-4-6', enabled: true },
      utility: { enabled: false },
    });
  });

  it('should migrate gemini.enabled: true → providers.google', () => {
    const input = {
      llm: {
        gemini: {
          enabled: true,
          type: 'genai',
          sdk_concurrency: 8,
          flash_model: 'gemini-2.5-flash',
          nlp_model: 'gemini-2.5-flash',
        },
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.providers.google).toEqual({
      mode: 'api',
      concurrency: 8,
    });
  });

  it('should propagate flash_model to mechanical axes when gemini enabled', () => {
    const input = {
      llm: {
        gemini: {
          enabled: true,
          flash_model: 'gemini-3-flash-preview',
          nlp_model: 'gemini-2.5-flash',
        },
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.axes.utility.model).toBe('gemini-3-flash-preview');
    expect(result.axes.duplication.model).toBe('gemini-3-flash-preview');
    expect(result.axes.overengineering.model).toBe('gemini-3-flash-preview');
  });

  it('should NOT override existing axis model when propagating flash_model', () => {
    const input = {
      llm: {
        gemini: {
          enabled: true,
          flash_model: 'gemini-3-flash-preview',
          nlp_model: 'gemini-2.5-flash',
        },
        axes: {
          utility: { model: 'custom-model' },
        },
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.axes.utility.model).toBe('custom-model');
    expect(result.axes.duplication.model).toBe('gemini-3-flash-preview');
  });

  it('should set models.code_summary from gemini nlp_model', () => {
    const input = {
      llm: {
        gemini: {
          enabled: true,
          nlp_model: 'gemini-2.5-flash',
        },
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.models.code_summary).toBe('gemini-2.5-flash');
  });

  it('should NOT set providers.google when gemini.enabled: false', () => {
    const input = {
      llm: {
        gemini: {
          enabled: false,
        },
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.providers?.google).toBeUndefined();
    expect(result.models?.code_summary).toBeUndefined();
  });

  it('should NOT set providers.google when gemini section is absent', () => {
    const input = {
      llm: {
        model: 'claude-sonnet-4-6',
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.providers?.google).toBeUndefined();
  });

  it('should map gemini type cli-core → subscription', () => {
    const input = {
      llm: {
        gemini: {
          enabled: true,
          type: 'cli-core',
          sdk_concurrency: 12,
        },
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.providers.google!.mode).toBe('subscription');
  });

  it('should map gemini type genai → api', () => {
    const input = {
      llm: {
        gemini: {
          enabled: true,
          type: 'genai',
          sdk_concurrency: 10,
        },
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.providers.google!.mode).toBe('api');
  });

  it('should preserve non-llm keys during migration', () => {
    const input = {
      project: { name: 'test' },
      scan: { include: ['src/**'] },
      llm: { model: 'test-model' },
    };
    const result = migrateConfigV0toV1(input);
    expect(result.project).toEqual({ name: 'test' });
    expect(result.scan).toEqual({ include: ['src/**'] });
    expect(result).not.toHaveProperty('llm');
  });

  it('should strip agentic_tools during migration', () => {
    const input = {
      llm: {
        agentic_tools: true,
        model: 'test',
      },
    };
    const result = migrateConfigV0toV1(input);
    expect(JSON.stringify(result)).not.toContain('agentic_tools');
  });
});
