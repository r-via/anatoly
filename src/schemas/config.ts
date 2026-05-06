// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { DEFAULT_MODELS } from '../core/default-models.js';

export const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  monorepo: z.boolean().default(false),
});

export const ScanConfigSchema = z.object({
  // Glob patterns describing the files to audit. Anatoly is language-agnostic
  // and does not bake TypeScript globs into the schema. The first-run wizard
  // emits an appropriate starter based on the detected project; users of
  // other languages should write their own patterns (Python: '**/*.py', Go:
  // '**/*.go', etc). When empty, nothing is scanned — anatoly tells the user.
  include: z.array(z.string()).default([]),
  // Glob patterns to exclude from the include matches. Defaults are
  // deliberately minimal and Node-leaning (node_modules and dist) since
  // those directories show up in many projects. Per-language test patterns
  // belong in your own .anatoly.yml, not in the schema default.
  exclude: z.array(z.string()).default([
    'node_modules/**',
    'dist/**',
  ]),
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
  quality: z.string().default(DEFAULT_MODELS.quality),
  fast: z.string().default(DEFAULT_MODELS.fast),
  deliberation: z.string().default(DEFAULT_MODELS.deliberation),
  code_summary: z.string().optional(),
});

// --- v1.0 Agents ---

export const AgentsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  scaffolding: z.string().optional(),
  review: z.string().optional(),
  deliberation: z.string().optional(),
  /** Maximum agentic turns for multi-turn tool-use queries (tier 3, doc generation). */
  max_turns: z.int().min(1).max(200).default(30),
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

/** Per-axis embedding provider config (code or nlp). Provider is required; model, base_url, env_key optional. */
export const EmbeddingProviderConfigSchema = z.object({
  /** Provider identifier (e.g. 'openai', 'voyage', 'qwen', 'anatoly-local', or a custom name). */
  provider: z.string(),
  /** Model identifier for this axis. Defaults resolved from provider registry at runtime. */
  model: z.string().optional(),
  /** Base URL override. Known providers have defaults via the registry. */
  base_url: z.string().optional(),
  /** Environment variable name holding the API key. Known providers have defaults. */
  env_key: z.string().optional(),
}).passthrough();

/** Embedding provider configuration — split by axis (code vs NLP) for best-of-breed support. */
export const EmbeddingConfigSchema = z.object({
  code: EmbeddingProviderConfigSchema.optional(),
  nlp: EmbeddingProviderConfigSchema.optional(),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Embedding model for code vectors. 'auto' = detect hardware and pick best available. */
  code_model: z.string().default('auto'),
  /** Embedding model for NLP vectors (lite mode). 'auto' = all-MiniLM-L6-v2. */
  nlp_model: z.string().default('auto'),
  /** Weight for code similarity in hybrid search (0-1). NLP weight = 1 - code_weight. */
  code_weight: z.number().min(0).max(1).default(0.6),
  /** External or custom embedding provider configuration. Absent = auto mode (resolved by hardware/flag). */
  embedding: EmbeddingConfigSchema.optional(),
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
  scan: ScanConfigSchema.default({ include: [], exclude: ['node_modules/**', 'dist/**'] }),
  coverage: CoverageConfigSchema.default({
    enabled: true,
    command: 'npx vitest run --coverage.reporter=json',
    report_path: 'coverage/coverage-final.json',
  }),
  // v2.0 sections
  providers: ProvidersConfigSchema.default({ anthropic: { mode: 'subscription', concurrency: 24 } }),
  models: ModelsConfigSchema.default({
    quality: DEFAULT_MODELS.quality,
    fast: DEFAULT_MODELS.fast,
    deliberation: DEFAULT_MODELS.deliberation,
  }),
  agents: AgentsConfigSchema.default({ enabled: true, max_turns: 30 }),
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
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
