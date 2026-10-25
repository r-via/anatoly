// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { parseTestConfig } from './test-fixtures.js';
import {
  ConfigSchema,
  AxisConfigSchema,
  GenericProviderConfigSchema,
  resolveCommandModel,
  resolveModelEffort,
  type Config,
} from './config.js';

describe('ConfigSchema — v1.0 new sections', () => {
  it('should apply all defaults when given empty object', () => {
    const config = parseTestConfig({});
    expect(config.project.monorepo).toBe(false);
    // Schema is language-agnostic — the default include is empty so users
    // who add a config file without `scan` get an explicit "no patterns"
    // state rather than a silent TypeScript bias.
    expect(config.scan.include).toEqual([]);
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
      runtime: { timeout_per_call: 300, max_retries: 5 },
      models: { quality: 'claude-opus-4-6' },
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: { mode: 'off' as const },
      },
    };
    const result = ConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project.name).toBe('my-project');
      expect(result.data.runtime.timeout_per_call).toBe(300);
      expect(result.data.models.quality).toBe('claude-opus-4-6');
    }
  });
});

describe('ProvidersConfigSchema', () => {
  it('should default anthropic.concurrency to the uniform 8', () => {
    const config = parseTestConfig({});
    expect(config.providers.anthropic!.concurrency).toBe(8);
  });

  it('should accept custom anthropic concurrency', () => {
    const config = parseTestConfig({
      providers: { anthropic: { concurrency: 16 } },
    });
    expect(config.providers.anthropic!.concurrency).toBe(16);
  });
});

describe('ProvidersConfigSchema — Story 43.1 extensions', () => {
  // --- Anthropic mode ---
  it('should default anthropic.mode to subscription', () => {
    const config = parseTestConfig({});
    expect(config.providers.anthropic!.mode).toBe('subscription');
  });

  it('should accept anthropic.mode = api', () => {
    const config = parseTestConfig({
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
    const config = parseTestConfig({
      providers: { anthropic: { single_turn: 'subscription', agents: 'api' } },
    });
    expect(config.providers.anthropic!.single_turn).toBe('subscription');
    expect(config.providers.anthropic!.agents).toBe('api');
  });

  it('should default single_turn and agents to undefined', () => {
    const config = parseTestConfig({});
    expect(config.providers.anthropic!.single_turn).toBeUndefined();
    expect(config.providers.anthropic!.agents).toBeUndefined();
  });

  // --- anthropic optional ---
  it('should allow anthropic to be absent when a custom provider is present', () => {
    const config = parseTestConfig({
      providers: { ollama: { mode: 'api' } },
    });
    expect(config.providers.anthropic).toBeUndefined();
    expect(config.providers.ollama).toBeDefined();
  });

  // --- at least one provider required ---
  it('should reject empty providers object (no providers configured)', () => {
    const result = ConfigSchema.safeParse({ providers: {} });
    expect(result.success).toBe(false);
  });

  // --- GenericProviderConfigSchema / catchall ---
  it('should accept a custom provider via catchall (e.g., ollama)', () => {
    const config = parseTestConfig({
      providers: { ollama: { mode: 'api' } },
    });
    expect(config.providers.ollama).toBeDefined();
    expect(config.providers.ollama!.mode).toBe('api');
  });

  it('should default custom provider concurrency to 8', () => {
    const config = parseTestConfig({
      providers: { qwen: {} },
    });
    expect(config.providers.qwen!.concurrency).toBe(8);
  });

  it('should default custom provider mode to api', () => {
    const config = parseTestConfig({
      providers: { deepseek: {} },
    });
    expect(config.providers.deepseek!.mode).toBe('api');
  });

  it('should accept custom provider with base_url and env_key', () => {
    const config = parseTestConfig({
      providers: { ollama: { mode: 'api', base_url: 'http://localhost:11434', env_key: 'OLLAMA_KEY' } },
    });
    expect(config.providers.ollama!.base_url).toBe('http://localhost:11434');
    expect(config.providers.ollama!.env_key).toBe('OLLAMA_KEY');
  });

  it('should accept multiple providers simultaneously', () => {
    const config = parseTestConfig({
      providers: {
        anthropic: { mode: 'api' },
        ollama: { mode: 'api', base_url: 'http://localhost:11434' },
      },
    });
    expect(config.providers.anthropic!.mode).toBe('api');
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
    const config = parseTestConfig({});
    expect(config.models.quality).toBeTruthy();
    expect(config.models.fast).toBeTruthy();
    expect(config.models.deliberation).toBeTruthy();
  });

  it('should use provider/model format for defaults', () => {
    const config = parseTestConfig({});
    expect(config.models.quality).toContain('/');
    expect(config.models.fast).toContain('/');
    expect(config.models.deliberation).toContain('/');
  });

  it('should default code_summary to undefined', () => {
    const config = parseTestConfig({});
    expect(config.models.code_summary).toBeUndefined();
  });

  it('should accept custom models', () => {
    const config = parseTestConfig({
      models: { quality: 'custom-model', code_summary: 'custom-fast-model' },
    });
    expect(config.models.quality).toBe('custom-model');
    expect(config.models.code_summary).toBe('custom-fast-model');
  });
});

describe('AgentsConfigSchema', () => {
  it('should default enabled to true', () => {
    const config = parseTestConfig({});
    expect(config.agents.enabled).toBe(true);
  });

  it('should default scaffolding, review, deliberation to undefined', () => {
    const config = parseTestConfig({});
    expect(config.agents.scaffolding).toBeUndefined();
    expect(config.agents.review).toBeUndefined();
    expect(config.agents.deliberation).toBeUndefined();
  });

  it('should accept agent overrides', () => {
    const config = parseTestConfig({
      agents: { deliberation: 'custom-model' },
    });
    expect(config.agents.deliberation).toBe('custom-model');
    expect(config.agents.enabled).toBe(true);
  });
});

describe('RuntimeConfigSchema', () => {
  it('should default timeout_per_call to 600', () => {
    const config = parseTestConfig({});
    expect(config.runtime.timeout_per_call).toBe(600);
  });

  it('should default max_retries to 3', () => {
    const config = parseTestConfig({});
    expect(config.runtime.max_retries).toBe(3);
  });

  it('should default concurrency to 8', () => {
    const config = parseTestConfig({});
    expect(config.runtime.concurrency).toBe(8);
  });

  it('should default min_confidence to 70', () => {
    const config = parseTestConfig({});
    expect(config.runtime.min_confidence).toBe(70);
  });

  it('should default max_stop_iterations to 3', () => {
    const config = parseTestConfig({});
    expect(config.runtime.max_stop_iterations).toBe(3);
  });

  it('should accept custom runtime values', () => {
    const config = parseTestConfig({
      runtime: { timeout_per_call: 300, concurrency: 4 },
    });
    expect(config.runtime.timeout_per_call).toBe(300);
    expect(config.runtime.concurrency).toBe(4);
  });

  it('should reject timeout_per_call below 1', () => {
    expect(ConfigSchema.safeParse({ runtime: { timeout_per_call: 0 } }).success).toBe(false);
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
    const config = parseTestConfig({});
    expect(config.axes.utility?.enabled).toBe(true);
    expect(config.axes.correction?.enabled).toBe(true);
  });

  it('should set present axes to enabled by default', () => {
    const config = parseTestConfig({
      axes: { utility: {}, duplication: {} },
    });
    expect(config.axes.utility?.enabled).toBe(true);
    expect(config.axes.duplication?.enabled).toBe(true);
    expect(config.axes.correction).toBeUndefined();
  });

  it('should accept per-axis model override at top level', () => {
    const config = parseTestConfig({
      axes: {
        correction: { model: 'claude-opus-4-20250514' },
      },
    });
    expect(config.axes.correction?.model).toBe('claude-opus-4-20250514');
    expect(config.axes.utility).toBeUndefined();
  });

  it('should accept disabling an axis at top level', () => {
    const config = parseTestConfig({
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
    const config = parseTestConfig({ llm: { model: 'custom' } });
    expect((config as Record<string, unknown>).llm).toBeUndefined();
  });
});

describe('NotificationsConfigSchema — Story 45.1', () => {
  it('should default notifications to undefined when absent from YAML', () => {
    const config = parseTestConfig({});
    expect(config.notifications).toBeUndefined();
  });

  it('should accept notifications.telegram with enabled and chat_id', () => {
    const config = parseTestConfig({
      notifications: {
        telegram: { enabled: true, chat_id: '-1001234567890' },
      },
    });
    expect(config.notifications!.telegram!.enabled).toBe(true);
    expect(config.notifications!.telegram!.chat_id).toBe('-1001234567890');
  });

  it('should default bot_token_env to ANATOLY_TELEGRAM_BOT_TOKEN', () => {
    const config = parseTestConfig({
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
    const config = parseTestConfig({
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
    const config = parseTestConfig({
      notifications: {
        telegram: { enabled: true, chat_id: '-100123' },
      },
    });
    expect(config.notifications!.telegram!.report_url).toBeUndefined();
  });

  it('should accept custom bot_token_env', () => {
    const config = parseTestConfig({
      notifications: {
        telegram: { enabled: true, chat_id: '-100123', bot_token_env: 'MY_BOT_TOKEN' },
      },
    });
    expect(config.notifications!.telegram!.bot_token_env).toBe('MY_BOT_TOKEN');
  });

  it('should accept telegram.enabled=false without chat_id', () => {
    const config = parseTestConfig({
      notifications: {
        telegram: { enabled: false },
      },
    });
    expect(config.notifications!.telegram!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RagConfigSchema — Story 50.1: Embedding provider config
// ---------------------------------------------------------------------------

describe('RagConfigSchema — embedding section (Story 50.1)', () => {
  it('should default rag.embedding to undefined when absent', () => {
    const config = parseTestConfig({});
    expect(config.rag.embedding).toBeUndefined();
  });

  it('should preserve existing rag defaults when embedding absent', () => {
    const config = parseTestConfig({});
    expect(config.rag.enabled).toBe(true);
    expect(config.rag.code_model).toBe('auto');
    expect(config.rag.nlp_model).toBe('auto');
    expect(config.rag.code_weight).toBe(0.6);
  });

  it('should accept embedding.code only (nlp undefined)', () => {
    const config = parseTestConfig({
      rag: {
        embedding: {
          code: { provider: 'openai', model: 'text-embedding-3-large' },
        },
      },
    });
    expect(config.rag.embedding!.code!.provider).toBe('openai');
    expect(config.rag.embedding!.code!.model).toBe('text-embedding-3-large');
    expect(config.rag.embedding!.nlp).toBeUndefined();
  });

  it('should accept best-of-breed code + nlp combo', () => {
    const config = parseTestConfig({
      rag: {
        embedding: {
          code: { provider: 'voyage', model: 'voyage-code-3' },
          nlp: { provider: 'qwen', model: 'text-embedding-v4', env_key: 'DASHSCOPE_API_KEY' },
        },
      },
    });
    expect(config.rag.embedding!.code!.provider).toBe('voyage');
    expect(config.rag.embedding!.code!.model).toBe('voyage-code-3');
    expect(config.rag.embedding!.code!.base_url).toBeUndefined();
    expect(config.rag.embedding!.nlp!.provider).toBe('qwen');
    expect(config.rag.embedding!.nlp!.model).toBe('text-embedding-v4');
    expect(config.rag.embedding!.nlp!.env_key).toBe('DASHSCOPE_API_KEY');
    expect(config.rag.embedding!.nlp!.base_url).toBeUndefined();
  });

  it('should accept custom provider with base_url and env_key', () => {
    const config = parseTestConfig({
      rag: {
        embedding: {
          code: {
            provider: 'my-internal',
            base_url: 'https://embed.internal/v1',
            env_key: 'INTERNAL_KEY',
            model: 'foo',
          },
          nlp: {
            provider: 'my-internal',
            base_url: 'https://embed.internal/v1',
            env_key: 'INTERNAL_KEY',
            model: 'bar',
          },
        },
      },
    });
    expect(config.rag.embedding!.code!.provider).toBe('my-internal');
    expect(config.rag.embedding!.code!.base_url).toBe('https://embed.internal/v1');
    expect(config.rag.embedding!.code!.env_key).toBe('INTERNAL_KEY');
    expect(config.rag.embedding!.code!.model).toBe('foo');
    expect(config.rag.embedding!.nlp!.provider).toBe('my-internal');
    expect(config.rag.embedding!.nlp!.model).toBe('bar');
  });

  it('should accept local-advanced provider', () => {
    const config = parseTestConfig({
      rag: {
        embedding: {
          code: { provider: 'local-advanced' },
          nlp: { provider: 'local-advanced' },
        },
      },
    });
    expect(config.rag.embedding!.code!.provider).toBe('local-advanced');
    expect(config.rag.embedding!.nlp!.provider).toBe('local-advanced');
  });

  it('should accept empty embedding object (both code and nlp undefined)', () => {
    const config = parseTestConfig({
      rag: { embedding: {} },
    });
    expect(config.rag.embedding).toBeDefined();
    expect(config.rag.embedding!.code).toBeUndefined();
    expect(config.rag.embedding!.nlp).toBeUndefined();
  });

  it('should require provider field when code is specified', () => {
    const result = ConfigSchema.safeParse({
      rag: {
        embedding: {
          code: { model: 'text-embedding-3-large' },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DocumentationConfigSchema — Story 54.1: Reference-first documentation config
// ---------------------------------------------------------------------------


describe('DocumentationConfigSchema — Story 54.1', () => {
  // AC3 case 1: valid config in mode `lite` — no sub-config needed; reference
  // docs are retrieved per-file via RAG at review time.
  it('should accept a valid config in mode lite (no lite sub-block)', () => {
    const result = ConfigSchema.safeParse({
      documentation: {
        reference: {
          paths: ['docs/**/*.md', 'README.md'],
          inline_comments: { enabled: false },
        },
        internal: {
          mode: 'lite',
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.documentation.internal.mode).toBe('lite');
      expect(result.data.documentation.reference.paths).toEqual(['docs/**/*.md', 'README.md']);
    }
  });

  // AC3 case 2: valid config in mode `full`
  it('should accept a valid config in mode full', () => {
    const result = ConfigSchema.safeParse({
      documentation: {
        reference: {
          paths: ['docs/**/*.md'],
          inline_comments: { enabled: true, kinds: ['jsdoc'], include: ['src/**/*.ts'] },
        },
        internal: {
          mode: 'full',
          full: { sync_to_repo: false },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.documentation.internal.mode).toBe('full');
      expect(result.data.documentation.internal.full!.sync_to_repo).toBe(false);
      expect(result.data.documentation.reference.inline_comments.enabled).toBe(true);
    }
  });

  // AC3 case 3: valid config in mode `off`
  it('should accept a valid config in mode off', () => {
    const result = ConfigSchema.safeParse({
      documentation: {
        reference: {
          paths: ['README.md'],
          inline_comments: { enabled: false },
        },
        internal: { mode: 'off' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.documentation.internal.mode).toBe('off');
      expect(result.data.documentation.internal.full).toBeUndefined();
    }
  });

  // AC3 case 4: internal.mode absent → error
  it('should reject documentation with internal.mode absent', () => {
    const result = ConfigSchema.safeParse({
      documentation: {
        reference: { paths: ['docs/**/*.md'], inline_comments: { enabled: false } },
        internal: {},
      },
    });
    expect(result.success).toBe(false);
  });

  // AC3 case 5: reference.paths empty → error
  it('should reject documentation with empty reference.paths', () => {
    const result = ConfigSchema.safeParse({
      documentation: {
        reference: { paths: [], inline_comments: { enabled: false } },
        internal: { mode: 'off' },
      },
    });
    expect(result.success).toBe(false);
  });

  // AC3 case 6: absolute path in reference.paths → error (NFR8)
  it('should reject absolute paths in reference.paths', () => {
    const resultSlash = ConfigSchema.safeParse({
      documentation: {
        reference: { paths: ['/etc/docs/**/*.md'], inline_comments: { enabled: false } },
        internal: { mode: 'off' },
      },
    });
    expect(resultSlash.success).toBe(false);

    const resultBackslash = ConfigSchema.safeParse({
      documentation: {
        reference: { paths: ['\\docs\\**\\*.md'], inline_comments: { enabled: false } },
        internal: { mode: 'off' },
      },
    });
    expect(resultBackslash.success).toBe(false);

    const resultDotDot = ConfigSchema.safeParse({
      documentation: {
        reference: { paths: ['../other-project/docs/**'], inline_comments: { enabled: false } },
        internal: { mode: 'off' },
      },
    });
    expect(resultDotDot.success).toBe(false);
  });

  // Extra: mode lite requires lite sub-object
  it('should accept mode lite without any sub-object (per-file RAG retrieval)', () => {
    const result = ConfigSchema.safeParse({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: { mode: 'lite' },
      },
    });
    expect(result.success).toBe(true);
  });

  // Extra: mode full requires full sub-object
  it('should reject mode full without full sub-object', () => {
    const result = ConfigSchema.safeParse({
      documentation: {
        reference: { paths: ['README.md'], inline_comments: { enabled: false } },
        internal: { mode: 'full' },
      },
    });
    expect(result.success).toBe(false);
  });

  // Extra: old docs_path format is no longer accepted
  it('should not accept old docs_path format', () => {
    const result = ConfigSchema.safeParse({
      documentation: { docs_path: 'docs' },
    });
    expect(result.success).toBe(false);
  });

  // Extra: inline_comments enabled requires kinds and include
  it('should reject inline_comments enabled without kinds', () => {
    const result = ConfigSchema.safeParse({
      documentation: {
        reference: {
          paths: ['README.md'],
          inline_comments: { enabled: true },
        },
        internal: { mode: 'off' },
      },
    });
    expect(result.success).toBe(false);
  });

  // Extra: module_mapping is preserved
  it('should accept optional module_mapping', () => {
    const result = ConfigSchema.safeParse({
      documentation: {
        reference: {
          paths: ['docs/**/*.md'],
          inline_comments: { enabled: false },
          module_mapping: { 'api-reference': ['src/api/**'] },
        },
        internal: { mode: 'off' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.documentation.reference.module_mapping).toEqual({
        'api-reference': ['src/api/**'],
      });
    }
  });

  // parseTestConfig({}) still works — documentation gets default
  it('should apply documentation defaults when config is empty', () => {
    const config = parseTestConfig({});
    expect(config.documentation).toBeDefined();
    expect(config.documentation.internal.mode).toBe('off');
    expect(config.documentation.reference.paths.length).toBeGreaterThan(0);
  });
});

describe('Exported schemas', () => {
  it('should export all v1.0 + v2.0 + embedding schema names', async () => {
    const mod = await import('./config.js');
    expect(mod.AnthropicProviderConfigSchema).toBeDefined();
    expect(mod.GenericProviderConfigSchema).toBeDefined();
    expect(mod.ProvidersConfigSchema).toBeDefined();
    expect(mod.ModelsConfigSchema).toBeDefined();
    expect(mod.AgentsConfigSchema).toBeDefined();
    expect(mod.RuntimeConfigSchema).toBeDefined();
    expect(mod.AxisConfigSchema).toBeDefined();
    expect(mod.ConfigSchema).toBeDefined();
    expect(mod.TelegramNotificationSchema).toBeDefined();
    expect(mod.NotificationsConfigSchema).toBeDefined();
    expect(mod.EmbeddingProviderConfigSchema).toBeDefined();
    expect(mod.EmbeddingConfigSchema).toBeDefined();
  });
});

describe('resolveCommandModel', () => {
  const base = (commands?: unknown): Config => ({
    models: { quality: 'p/quality', fast: 'p/fast', deliberation: 'p/deliberation' },
    commands,
  } as unknown as Config);

  it('uses the per-command override first', () => {
    expect(resolveCommandModel(base({ model: 'p/default', scope: 'p/scope' }), 'scope')).toBe('p/scope');
  });

  it('falls back to the commands.model default', () => {
    expect(resolveCommandModel(base({ model: 'p/default' }), 'scope')).toBe('p/default');
  });

  it('falls back to models.quality when commands is absent (never deliberation)', () => {
    const m = resolveCommandModel(base(undefined), 'scope');
    expect(m).toBe('p/quality');
    expect(m).not.toBe('p/deliberation');
  });

  it('falls back to models.quality when the command has no override and no default', () => {
    expect(resolveCommandModel(base({ refresh: 'p/refresh' }), 'scope')).toBe('p/quality');
  });
});

describe('resolveModelEffort', () => {
  const withEffort = (effort?: unknown, codeSummary?: string): Config => parseTestConfig({
    models: {
      quality: 'anthropic/claude-sonnet-5-5',
      fast: 'anthropic/claude-haiku-5-5',
      deliberation: 'anthropic/claude-opus-5-5',
      ...(codeSummary ? { code_summary: codeSummary } : {}),
      ...(effort ? { effort } : {}),
    },
  });

  it('defaults every tier to high', () => {
    const config = withEffort();
    for (const model of ['anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5', 'anthropic/claude-opus-5-5']) {
      expect(resolveModelEffort(config, model)).toBe('high');
    }
  });

  it('returns the configured effort of the tier the model serves, prefixed or bare', () => {
    const config = withEffort({ quality: 'xhigh', fast: 'low', deliberation: 'max' });
    expect(resolveModelEffort(config, 'anthropic/claude-sonnet-5-5')).toBe('xhigh');
    expect(resolveModelEffort(config, 'claude-sonnet-5-5')).toBe('xhigh');
    expect(resolveModelEffort(config, 'anthropic/claude-opus-5-5')).toBe('max');
  });

  it('keeps the default for a tier left unset next to configured ones', () => {
    const config = withEffort({ quality: 'medium' });
    expect(resolveModelEffort(config, 'anthropic/claude-opus-5-5')).toBe('high');
  });

  it('takes the highest configured effort when one model serves several tiers', () => {
    // code_summary falls back to fast: Haiku serves both.
    const config = withEffort({ fast: 'low', code_summary: 'medium' });
    expect(resolveModelEffort(config, 'anthropic/claude-haiku-5-5')).toBe('medium');
  });

  it('does not let an unset tier override a configured one on a shared model', () => {
    const config = withEffort({ fast: 'low' });
    expect(resolveModelEffort(config, 'anthropic/claude-haiku-5-5')).toBe('low');
  });

  it('applies code_summary to a dedicated summary model', () => {
    const config = withEffort({ code_summary: 'low' }, 'anthropic/claude-haiku-4-5-20251001');
    expect(resolveModelEffort(config, 'anthropic/claude-haiku-4-5-20251001')).toBe('low');
    expect(resolveModelEffort(config, 'anthropic/claude-haiku-5-5')).toBe('high');
  });

  it('gives a model serving no tier the quality effort', () => {
    const config = withEffort({ quality: 'xhigh' });
    expect(resolveModelEffort(config, 'anthropic/claude-fable-5-1')).toBe('xhigh');
  });

  it('uses the quality default without a config', () => {
    expect(resolveModelEffort(undefined, 'claude-sonnet-5-5')).toBe('high');
  });

  it('rejects an unknown effort level', () => {
    expect(() => withEffort({ quality: 'extreme' })).toThrow();
  });
});
