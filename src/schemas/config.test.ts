// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { ConfigSchema, AxisConfigSchema } from './config.js';

describe('ConfigSchema — v1.0 new sections', () => {
  it('should apply all defaults when given empty object', () => {
    const config = ConfigSchema.parse({});
    expect(config.project.monorepo).toBe(false);
    expect(config.scan.include).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
    expect(config.scan.exclude).toContain('node_modules/**');
    expect(config.coverage.enabled).toBe(true);
  });

  it('should accept a fully specified config (new format)', () => {
    const input = {
      project: { name: 'my-project', monorepo: true },
      scan: {
        include: ['packages/*/src/**/*.ts'],
        exclude: ['node_modules/**'],
      },
      coverage: {
        enabled: false,
        command: 'npx jest --coverage',
        report_path: 'coverage/lcov.json',
      },
      runtime: { timeout_per_file: 300, max_retries: 5 },
      models: { quality: 'claude-opus-4-6' },
    };
    const result = ConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project.name).toBe('my-project');
      expect(result.data.runtime.timeout_per_file).toBe(300);
      expect(result.data.models.quality).toBe('claude-opus-4-6');
    }
  });
});

describe('ProvidersConfigSchema', () => {
  it('should default anthropic.concurrency to 24', () => {
    const config = ConfigSchema.parse({});
    expect(config.providers.anthropic.concurrency).toBe(24);
  });

  it('should default google to undefined (Gemini disabled)', () => {
    const config = ConfigSchema.parse({});
    expect(config.providers.google).toBeUndefined();
  });

  it('should accept providers.google with empty object — defaults applied', () => {
    const config = ConfigSchema.parse({
      providers: { google: {} },
    });
    expect(config.providers.google).toBeDefined();
    expect(config.providers.google!.mode).toBe('subscription');
    expect(config.providers.google!.concurrency).toBe(10);
  });

  it('should accept providers.google.mode = api', () => {
    const config = ConfigSchema.parse({
      providers: { google: { mode: 'api' } },
    });
    expect(config.providers.google!.mode).toBe('api');
  });

  it('should reject providers.google.mode = invalid', () => {
    const result = ConfigSchema.safeParse({
      providers: { google: { mode: 'invalid' } },
    });
    expect(result.success).toBe(false);
  });

  it('should accept custom anthropic concurrency', () => {
    const config = ConfigSchema.parse({
      providers: { anthropic: { concurrency: 16 } },
    });
    expect(config.providers.anthropic.concurrency).toBe(16);
  });
});

describe('ModelsConfigSchema', () => {
  it('should default quality to claude-sonnet-4-6', () => {
    const config = ConfigSchema.parse({});
    expect(config.models.quality).toBe('claude-sonnet-4-6');
  });

  it('should default fast to claude-haiku-4-5-20251001', () => {
    const config = ConfigSchema.parse({});
    expect(config.models.fast).toBe('claude-haiku-4-5-20251001');
  });

  it('should default deliberation to claude-opus-4-6', () => {
    const config = ConfigSchema.parse({});
    expect(config.models.deliberation).toBe('claude-opus-4-6');
  });

  it('should default code_summary to undefined', () => {
    const config = ConfigSchema.parse({});
    expect(config.models.code_summary).toBeUndefined();
  });

  it('should accept custom models', () => {
    const config = ConfigSchema.parse({
      models: { quality: 'custom-model', code_summary: 'gemini-2.5-flash' },
    });
    expect(config.models.quality).toBe('custom-model');
    expect(config.models.code_summary).toBe('gemini-2.5-flash');
  });
});

describe('AgentsConfigSchema', () => {
  it('should default enabled to true', () => {
    const config = ConfigSchema.parse({});
    expect(config.agents.enabled).toBe(true);
  });

  it('should default scaffolding, review, deliberation to undefined', () => {
    const config = ConfigSchema.parse({});
    expect(config.agents.scaffolding).toBeUndefined();
    expect(config.agents.review).toBeUndefined();
    expect(config.agents.deliberation).toBeUndefined();
  });

  it('should accept agent overrides', () => {
    const config = ConfigSchema.parse({
      agents: { deliberation: 'custom-model' },
    });
    expect(config.agents.deliberation).toBe('custom-model');
    expect(config.agents.enabled).toBe(true);
  });
});

describe('RuntimeConfigSchema', () => {
  it('should default timeout_per_file to 600', () => {
    const config = ConfigSchema.parse({});
    expect(config.runtime.timeout_per_file).toBe(600);
  });

  it('should default max_retries to 3', () => {
    const config = ConfigSchema.parse({});
    expect(config.runtime.max_retries).toBe(3);
  });

  it('should default concurrency to 8', () => {
    const config = ConfigSchema.parse({});
    expect(config.runtime.concurrency).toBe(8);
  });

  it('should default min_confidence to 70', () => {
    const config = ConfigSchema.parse({});
    expect(config.runtime.min_confidence).toBe(70);
  });

  it('should default max_stop_iterations to 3', () => {
    const config = ConfigSchema.parse({});
    expect(config.runtime.max_stop_iterations).toBe(3);
  });

  it('should accept custom runtime values', () => {
    const config = ConfigSchema.parse({
      runtime: { timeout_per_file: 300, concurrency: 4 },
    });
    expect(config.runtime.timeout_per_file).toBe(300);
    expect(config.runtime.concurrency).toBe(4);
  });

  it('should reject timeout_per_file below 1', () => {
    expect(ConfigSchema.safeParse({ runtime: { timeout_per_file: 0 } }).success).toBe(false);
  });

  it('should reject min_confidence below 0', () => {
    expect(ConfigSchema.safeParse({ runtime: { min_confidence: -1 } }).success).toBe(false);
  });

  it('should reject min_confidence above 100', () => {
    expect(ConfigSchema.safeParse({ runtime: { min_confidence: 101 } }).success).toBe(false);
  });
});

describe('AxesConfigSchema (top-level)', () => {
  it('should default all axes to enabled via top-level axes', () => {
    const config = ConfigSchema.parse({});
    expect(config.axes.utility.enabled).toBe(true);
    expect(config.axes.duplication.enabled).toBe(true);
    expect(config.axes.correction.enabled).toBe(true);
    expect(config.axes.overengineering.enabled).toBe(true);
    expect(config.axes.tests.enabled).toBe(true);
    expect(config.axes.best_practices.enabled).toBe(true);
    expect(config.axes.documentation.enabled).toBe(true);
  });

  it('should accept per-axis model override at top level', () => {
    const config = ConfigSchema.parse({
      axes: {
        correction: { model: 'claude-opus-4-20250514' },
      },
    });
    expect(config.axes.correction.model).toBe('claude-opus-4-20250514');
    expect(config.axes.utility.model).toBeUndefined();
  });

  it('should accept disabling an axis at top level', () => {
    const config = ConfigSchema.parse({
      axes: {
        best_practices: { enabled: false },
      },
    });
    expect(config.axes.best_practices.enabled).toBe(false);
    expect(config.axes.utility.enabled).toBe(true);
  });

  it('should validate standalone AxisConfigSchema', () => {
    expect(AxisConfigSchema.safeParse({}).success).toBe(true);
    expect(AxisConfigSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(AxisConfigSchema.safeParse({ enabled: true, model: 'claude-haiku-4-5-20251001' }).success).toBe(true);
  });
});

describe('Legacy llm section (deprecated, kept for consumer compat)', () => {
  it('should still parse llm section for backward compat', () => {
    const config = ConfigSchema.parse({});
    expect(config.llm.timeout_per_file).toBe(600);
    expect(config.llm.max_retries).toBe(3);
    expect(config.llm.sdk_concurrency).toBe(24);
    expect(config.llm.min_confidence).toBe(70);
    expect(config.llm.gemini.enabled).toBe(false);
  });

  it('should accept legacy llm overrides', () => {
    const config = ConfigSchema.parse({
      llm: { model: 'custom-model', timeout_per_file: 300 },
    });
    expect(config.llm.model).toBe('custom-model');
    expect(config.llm.timeout_per_file).toBe(300);
  });

  it('should still have llm.axes', () => {
    const config = ConfigSchema.parse({});
    expect(config.llm.axes.utility.enabled).toBe(true);
  });
});

describe('Exported schemas', () => {
  it('should export all v1.0 schema names', async () => {
    const mod = await import('./config.js');
    expect(mod.AnthropicProviderConfigSchema).toBeDefined();
    expect(mod.GoogleProviderConfigSchema).toBeDefined();
    expect(mod.ProvidersConfigSchema).toBeDefined();
    expect(mod.ModelsConfigSchema).toBeDefined();
    expect(mod.AgentsConfigSchema).toBeDefined();
    expect(mod.RuntimeConfigSchema).toBeDefined();
    expect(mod.AxisConfigSchema).toBeDefined();
    expect(mod.ConfigSchema).toBeDefined();
    // Legacy schemas still available for migration
    expect(mod.LlmConfigSchema).toBeDefined();
    expect(mod.GeminiConfigSchema).toBeDefined();
  });
});
