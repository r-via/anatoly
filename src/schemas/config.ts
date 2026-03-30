// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';

export const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  monorepo: z.boolean().default(false),
});

export const ScanConfigSchema = z.object({
  include: z.array(z.string()).default(['src/**/*.ts', 'src/**/*.tsx']),
  exclude: z.array(z.string()).default([
    'node_modules/**',
    'dist/**',
    '**/*.test.ts',
    '**/*.spec.ts',
  ]),
  auto_detect: z.boolean().default(true),
});

export const CoverageConfigSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().default('npx vitest run --coverage.reporter=json'),
  report_path: z.string().default('coverage/coverage-final.json'),
});

export const AxisConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  /** Glob patterns for files to skip on this axis. Matched against relative file paths. */
  skip: z.array(z.string()).optional(),
});

export const AxesConfigSchema = z.object({
  utility: AxisConfigSchema.optional(),
  duplication: AxisConfigSchema.optional(),
  correction: AxisConfigSchema.optional(),
  overengineering: AxisConfigSchema.optional(),
  tests: AxisConfigSchema.optional(),
  best_practices: AxisConfigSchema.optional(),
  documentation: AxisConfigSchema.optional(),
});

// --- v2.0 Providers ---

/** Accepted provider transport modes. */
const ProviderModeSchema = z.enum(['subscription', 'api']);

/** Base fields shared by all provider configs. */
export const GenericProviderConfigSchema = z.object({
  mode: ProviderModeSchema.default('api'),
  concurrency: z.int().min(1).max(32).default(8),
  /** Override transport mode for single-turn (axis) calls. Takes precedence over `mode`. */
  single_turn: ProviderModeSchema.optional(),
  /** Override transport mode for agentic calls. Takes precedence over `mode`. */
  agents: ProviderModeSchema.optional(),
  /** Base URL for OpenAI-compatible providers. Known providers have defaults via the registry. */
  base_url: z.string().optional(),
  /** Environment variable name holding the API key. Known providers have defaults. */
  env_key: z.string().optional(),
});

export const AnthropicProviderConfigSchema = GenericProviderConfigSchema.extend({
  mode: ProviderModeSchema.default('subscription'),
  concurrency: z.int().min(1).max(32).default(24),
});

export const GoogleProviderConfigSchema = GenericProviderConfigSchema.extend({
  mode: ProviderModeSchema.default('subscription'),
  concurrency: z.int().min(1).max(32).default(10),
});

export const ProvidersConfigSchema = z.object({
  anthropic: AnthropicProviderConfigSchema.optional(),
  google: GoogleProviderConfigSchema.optional(),
}).catchall(GenericProviderConfigSchema).refine(
  (data) => Object.keys(data).length > 0,
  'At least one provider must be configured',
);

// --- v1.0 Models ---

export const ModelsConfigSchema = z.object({
  quality: z.string().default('anthropic/claude-sonnet-4-6'),
  fast: z.string().default('anthropic/claude-haiku-4-5-20251001'),
  deliberation: z.string().default('anthropic/claude-opus-4-6'),
  code_summary: z.string().optional(),
});

// --- v1.0 Agents ---

export const AgentsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  scaffolding: z.string().optional(),
  review: z.string().optional(),
  deliberation: z.string().optional(),
});

// --- v1.0 Runtime ---

export const RuntimeConfigSchema = z.object({
  timeout_per_file: z.int().min(1).default(600),
  max_retries: z.int().min(1).max(10).default(3),
  concurrency: z.int().min(1).max(10).default(8),
  min_confidence: z.int().min(0).max(100).default(70),
  max_stop_iterations: z.int().min(1).max(10).default(3),
});

// --- Other sections ---

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Embedding model for code vectors. 'auto' = detect hardware and pick best available. */
  code_model: z.string().default('auto'),
  /** Embedding model for NLP vectors (lite mode). 'auto' = all-MiniLM-L6-v2. */
  nlp_model: z.string().default('auto'),
  /** Weight for code similarity in hybrid search (0-1). NLP weight = 1 - code_weight. */
  code_weight: z.number().min(0).max(1).default(0.6),
});

export const BadgeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** When true, display the pass/fail verdict label (e.g. CLEAN / NEEDS_REFACTOR) on the badge. */
  verdict: z.boolean().default(false),
  link: z.string().url().default('https://github.com/r-via/anatoly'),
});

export const LoggingConfigSchema = z.object({
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('warn'),
  file: z.string().optional(),
  pretty: z.boolean().default(true),
});

export const DocumentationConfigSchema = z.object({
  docs_path: z.string().default('docs'),
  /** Map from doc page name (key) to source module globs (values) that the page covers. */
  module_mapping: z.record(z.string(), z.array(z.string())).optional(),
});

export const OutputConfigSchema = z.object({
  max_runs: z.int().min(1).optional(),
});

export const SearchConfigSchema = z.object({
  provider: z.enum(['exa', 'brave']).optional(),
});

// --- Notifications ---

export const TelegramNotificationSchema = z.object({
  enabled: z.boolean().default(false),
  /** Telegram username (without @). The bot resolves this to a chat_id automatically. */
  username: z.string().optional(),
  /** Telegram chat ID (channel, group, or user). Resolved automatically from username if not set. */
  chat_id: z.string().optional(),
  /** Environment variable name holding the bot token. Never store tokens in YAML. */
  bot_token_env: z.string().default('ANATOLY_TELEGRAM_BOT_TOKEN'),
  /** Optional URL to the published report (appended as link in the message). */
  report_url: z.string().url().optional(),
}).refine(
  (data) => !data.enabled || (data.enabled && (data.chat_id || data.username)),
  { message: 'chat_id or username is required when telegram notifications are enabled', path: ['username'] },
);

export const NotificationsConfigSchema = z.object({
  telegram: TelegramNotificationSchema.optional(),
});

// --- Main ConfigSchema ---

export const ConfigSchema = z.object({
  project: ProjectConfigSchema.default({ monorepo: false }),
  scan: ScanConfigSchema.default({
    include: ['src/**/*.ts', 'src/**/*.tsx'],
    exclude: ['node_modules/**', 'dist/**', '**/*.test.ts', '**/*.spec.ts'],
    auto_detect: true,
  }),
  coverage: CoverageConfigSchema.default({
    enabled: true,
    command: 'npx vitest run --coverage.reporter=json',
    report_path: 'coverage/coverage-final.json',
  }),
  // v2.0 sections
  providers: ProvidersConfigSchema.default({ anthropic: { mode: 'subscription', concurrency: 24 } }),
  models: ModelsConfigSchema.default({
    quality: 'anthropic/claude-sonnet-4-6',
    fast: 'anthropic/claude-haiku-4-5-20251001',
    deliberation: 'anthropic/claude-opus-4-6',
  }),
  agents: AgentsConfigSchema.default({ enabled: true }),
  runtime: RuntimeConfigSchema.default({
    timeout_per_file: 600,
    max_retries: 3,
    concurrency: 8,
    min_confidence: 70,
    max_stop_iterations: 3,
  }),
  axes: AxesConfigSchema.default({
    utility: { enabled: true },
    duplication: { enabled: true },
    correction: { enabled: true },
    overengineering: { enabled: true },
    tests: { enabled: true },
    best_practices: { enabled: true },
    documentation: { enabled: true },
  }),
  // Other sections
  rag: RagConfigSchema.default({ enabled: true, code_model: 'auto', nlp_model: 'auto', code_weight: 0.6 }),
  logging: LoggingConfigSchema.default({ level: 'warn', pretty: true }),
  output: OutputConfigSchema.default({}),
  badge: BadgeConfigSchema.default({
    enabled: true,
    verdict: false,
    link: 'https://github.com/r-via/anatoly',
  }),
  documentation: DocumentationConfigSchema.default({ docs_path: 'docs' }),
  search: SearchConfigSchema.default({}),
  notifications: NotificationsConfigSchema.optional(),
});

// --- Exported types ---

export type AxisConfig = z.infer<typeof AxisConfigSchema>;
export type GenericProviderConfig = z.infer<typeof GenericProviderConfigSchema>;
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfigSchema>;
export type GoogleProviderConfig = z.infer<typeof GoogleProviderConfigSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type TelegramNotificationConfig = z.infer<typeof TelegramNotificationSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
