// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import {
  ConfigSchema,
  AxisConfigSchema,
  AnthropicProviderConfigSchema,
  GoogleProviderConfigSchema,
  GenericProviderConfigSchema,
} from './config.js';

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
    expect(config.providers.anthropic!.concurrency).toBe(24);
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
    expect(config.providers.anthropic!.concurrency).toBe(16);
  });
});

describe('ProvidersConfigSchema — Story 43.1 extensions', () => {
  // --- Anthropic mode ---
  it('should default anthropic.mode to subscription', () => {
    const config = ConfigSchema.parse({});
    expect(config.providers.anthropic!.mode).toBe('subscription');
  });

  it('should accept anthropic.mode = api', () => {
    const config = ConfigSchema.parse({
      providers: { anthropic: { mode: 'api' } },
    });
    expect(config.providers.anthropic!.mode).toBe('api');
  });

  it('should reject anthropic.mode = invalid', () => {
    const result = ConfigSchema.safeParse({
      providers: { anthropic: { mode: 'invalid' } },
    });
    expect(result.success).toBe(false);
  });

  // --- single_turn / agents split ---
  it('should accept anthropic single_turn and agents mode overrides', () => {
    const config = ConfigSchema.parse({
      providers: { anthropic: { single_turn: 'subscription', agents: 'api' } },
    });
    expect(config.providers.anthropic!.single_turn).toBe('subscription');
    expect(config.providers.anthropic!.agents).toBe('api');
  });

  it('should accept google single_turn and agents mode overrides', () => {
    const config = ConfigSchema.parse({
      providers: { google: { single_turn: 'api', agents: 'subscription' } },
    });
    expect(config.providers.google!.single_turn).toBe('api');
    expect(config.providers.google!.agents).toBe('subscription');
  });

  it('should default single_turn and agents to undefined', () => {
    const config = ConfigSchema.parse({});
    expect(config.providers.anthropic!.single_turn).toBeUndefined();
    expect(config.providers.anthropic!.agents).toBeUndefined();
  });

  // --- anthropic optional ---
  it('should allow anthropic to be absent when google is present', () => {
    const config = ConfigSchema.parse({
      providers: { google: {} },
    });
    expect(config.providers.anthropic).toBeUndefined();
    expect(config.providers.google).toBeDefined();
  });

  // --- at least one provider required ---
  it('should reject empty providers object (no providers configured)', () => {
    const result = ConfigSchema.safeParse({ providers: {} });
    expect(result.success).toBe(false);
  });

  // --- GenericProviderConfigSchema / catchall ---
  it('should accept a custom provider via catchall (e.g., ollama)', () => {
    const config = ConfigSchema.parse({
      providers: { ollama: { mode: 'api' } },
    });
    expect(config.providers.ollama).toBeDefined();
    expect(config.providers.ollama!.mode).toBe('api');
  });

  it('should default custom provider concurrency to 8', () => {
    const config = ConfigSchema.parse({
      providers: { qwen: {} },
    });
    expect(config.providers.qwen!.concurrency).toBe(8);
  });

  it('should default custom provider mode to api', () => {
    const config = ConfigSchema.parse({
      providers: { deepseek: {} },
    });
    expect(config.providers.deepseek!.mode).toBe('api');
  });

  it('should accept custom provider with base_url and env_key', () => {
    const config = ConfigSchema.parse({
      providers: { ollama: { mode: 'api', base_url: 'http://localhost:11434', env_key: 'OLLAMA_KEY' } },
    });
    expect(config.providers.ollama!.base_url).toBe('http://localhost:11434');
    expect(config.providers.ollama!.env_key).toBe('OLLAMA_KEY');
  });

  it('should accept multiple providers simultaneously', () => {
    const config = ConfigSchema.parse({
      providers: {
        anthropic: { mode: 'api' },
        google: { mode: 'api' },
        ollama: { mode: 'api', base_url: 'http://localhost:11434' },
      },
    });
    expect(config.providers.anthropic!.mode).toBe('api');
    expect(config.providers.google!.mode).toBe('api');
    expect(config.providers.ollama!.mode).toBe('api');
  });
});

describe('GenericProviderConfigSchema standalone', () => {
  it('should parse empty object with defaults', () => {
    const result = GenericProviderConfigSchema.parse({});
    expect(result.mode).toBe('api');
    expect(result.concurrency).toBe(8);
    expect(result.base_url).toBeUndefined();
    expect(result.env_key).toBeUndefined();
  });

  it('should accept all fields', () => {
    const result = GenericProviderConfigSchema.parse({
      mode: 'api',
      base_url: 'https://api.example.com',
      env_key: 'MY_KEY',
      concurrency: 4,
    });
    expect(result.mode).toBe('api');
    expect(result.base_url).toBe('https://api.example.com');
    expect(result.env_key).toBe('MY_KEY');
    expect(result.concurrency).toBe(4);
  });
});

describe('ModelsConfigSchema', () => {
  it('should have non-empty defaults for quality, fast, deliberation', () => {
    const config = ConfigSchema.parse({});
    expect(config.models.quality).toBeTruthy();
    expect(config.models.fast).toBeTruthy();
    expect(config.models.deliberation).toBeTruthy();
  });

  it('should use provider/model format for defaults', () => {
    const config = ConfigSchema.parse({});
    expect(config.models.quality).toContain('/');
    expect(config.models.fast).toContain('/');
    expect(config.models.deliberation).toContain('/');
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
  it('should enable all axes by default when config is empty', () => {
    const config = ConfigSchema.parse({});
    expect(config.axes.utility?.enabled).toBe(true);
    expect(config.axes.correction?.enabled).toBe(true);
  });

  it('should set present axes to enabled by default', () => {
    const config = ConfigSchema.parse({
      axes: { utility: {}, duplication: {} },
    });
    expect(config.axes.utility?.enabled).toBe(true);
    expect(config.axes.duplication?.enabled).toBe(true);
    expect(config.axes.correction).toBeUndefined();
  });

  it('should accept per-axis model override at top level', () => {
    const config = ConfigSchema.parse({
      axes: {
        correction: { model: 'claude-opus-4-20250514' },
      },
    });
    expect(config.axes.correction?.model).toBe('claude-opus-4-20250514');
    expect(config.axes.utility).toBeUndefined();
  });

  it('should accept disabling an axis at top level', () => {
    const config = ConfigSchema.parse({
      axes: {
        best_practices: { enabled: false },
        utility: {},
      },
    });
    expect(config.axes.best_practices?.enabled).toBe(false);
    expect(config.axes.utility?.enabled).toBe(true);
  });

  it('should validate standalone AxisConfigSchema', () => {
    expect(AxisConfigSchema.safeParse({}).success).toBe(true);
    expect(AxisConfigSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(AxisConfigSchema.safeParse({ enabled: true, model: 'claude-haiku-4-5-20251001' }).success).toBe(true);
  });
});

describe('Legacy llm section removed (Story 42.4)', () => {
  it('should reject unknown llm key in strict parse', () => {
    // llm is no longer in the schema — Zod strips unknown keys by default
    const config = ConfigSchema.parse({ llm: { model: 'custom' } });
    expect((config as Record<string, unknown>).llm).toBeUndefined();
  });
});

describe('NotificationsConfigSchema — Story 45.1', () => {
  it('should default notifications to undefined when absent from YAML', () => {
    const config = ConfigSchema.parse({});
    expect(config.notifications).toBeUndefined();
  });

  it('should accept notifications.telegram with enabled and chat_id', () => {
    const config = ConfigSchema.parse({
      notifications: {
        telegram: { enabled: true, chat_id: '-1001234567890' },
      },
    });
    expect(config.notifications!.telegram!.enabled).toBe(true);
    expect(config.notifications!.telegram!.chat_id).toBe('-1001234567890');
  });

  it('should default bot_token_env to ANATOLY_TELEGRAM_BOT_TOKEN', () => {
    const config = ConfigSchema.parse({
      notifications: {
        telegram: { enabled: true, chat_id: '-100123' },
      },
    });
    expect(config.notifications!.telegram!.bot_token_env).toBe('ANATOLY_TELEGRAM_BOT_TOKEN');
  });

  it('should reject telegram.enabled=true without chat_id', () => {
    const result = ConfigSchema.safeParse({
      notifications: {
        telegram: { enabled: true },
      },
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid report_url', () => {
    const result = ConfigSchema.safeParse({
      notifications: {
        telegram: { enabled: true, chat_id: '-100123', report_url: 'not-a-url' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('should accept a valid report_url', () => {
    const config = ConfigSchema.parse({
      notifications: {
        telegram: {
          enabled: true,
          chat_id: '-100123',
          report_url: 'https://example.com/report',
        },
      },
    });
    expect(config.notifications!.telegram!.report_url).toBe('https://example.com/report');
  });

  it('should default report_url to undefined when absent', () => {
    const config = ConfigSchema.parse({
      notifications: {
        telegram: { enabled: true, chat_id: '-100123' },
      },
    });
    expect(config.notifications!.telegram!.report_url).toBeUndefined();
  });

  it('should accept custom bot_token_env', () => {
    const config = ConfigSchema.parse({
      notifications: {
        telegram: { enabled: true, chat_id: '-100123', bot_token_env: 'MY_BOT_TOKEN' },
      },
    });
    expect(config.notifications!.telegram!.bot_token_env).toBe('MY_BOT_TOKEN');
  });

  it('should accept telegram.enabled=false without chat_id', () => {
    const config = ConfigSchema.parse({
      notifications: {
        telegram: { enabled: false },
      },
    });
    expect(config.notifications!.telegram!.enabled).toBe(false);
  });
});

describe('Exported schemas', () => {
  it('should export all v1.0 + v2.0 schema names', async () => {
    const mod = await import('./config.js');
    expect(mod.AnthropicProviderConfigSchema).toBeDefined();
    expect(mod.GoogleProviderConfigSchema).toBeDefined();
    expect(mod.GenericProviderConfigSchema).toBeDefined();
    expect(mod.ProvidersConfigSchema).toBeDefined();
    expect(mod.ModelsConfigSchema).toBeDefined();
    expect(mod.AgentsConfigSchema).toBeDefined();
    expect(mod.RuntimeConfigSchema).toBeDefined();
    expect(mod.AxisConfigSchema).toBeDefined();
    expect(mod.ConfigSchema).toBeDefined();
    expect(mod.TelegramNotificationSchema).toBeDefined();
    expect(mod.NotificationsConfigSchema).toBeDefined();
  });
});
