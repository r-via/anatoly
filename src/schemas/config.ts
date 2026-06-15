// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { z } from 'zod';
import { DEFAULT_MODELS } from '../core/platform/index.js';

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
  // When true (default), files ignored by .gitignore are filtered out at scan
  // time by intersecting with `git ls-files`. The check is a no-op outside a
  // git repo. Surfaced as a yaml field so the behavior is declarative rather
  // than hidden runtime magic — set to false to audit gitignored files
  // explicitly (e.g. a generated dir you want to lint).
  respect_gitignore: z.boolean().default(true),
  // Glob patterns marking VENDORED / third-party code kept close to upstream
  // (e.g. shadcn/ui components under `**/components/ui/**`, generated clients).
  // These files are still audited, but the best-practices axis flags only real
  // defects (bugs, security, unhandled errors, dead code) there — not stylistic
  // preferences — since divergence from upstream complicates resync. Default
  // empty (opt-in).
  vendored: z.array(z.string()).default([]),
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

// Anthropic only overrides the transport `mode` default; `concurrency`
// is intentionally NOT overridden so every provider shares the single uniform
// default (8) from GenericProviderConfigSchema. The first-run wizard writes
// `concurrency: 8` explicitly into the generated config — this default is only
// a safety net for hand-written configs that omit it.
export const AnthropicProviderConfigSchema = GenericProviderConfigSchema.extend({
  mode: ProviderModeSchema.default('subscription'),
});

export const ProvidersConfigSchema = z.object({
  anthropic: AnthropicProviderConfigSchema.optional(),
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

/**
 * Explicit model selection for standalone commands that make LLM calls
 * outside an audit run (`docs arbitrate refresh`, `init --scope`, ...).
 *
 * `model` is the default for all such commands; a command key overrides it.
 * All optional: an absent entry makes {@link resolveCommandModel} fall back
 * to the single-turn `models.quality` slot. These calls are single-turn, so
 * the fallback is deliberately NOT `models.deliberation` (the agentic slot).
 */
export const CommandsConfigSchema = z.object({
  model: z.string().optional(),
  scope: z.string().optional(),
  refresh: z.string().optional(),
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

// --- Invariants phase ---

/**
 * Gate for the `invariants` pipeline phase (a pre-deliberation phase, NOT an
 * axis). `anatoly init` writes this enabled; the schema default stays disabled
 * so configs that omit the section (and the no-config path) remain a no-op,
 * and it can be toggled off here or forced on with the `--invariants` CLI flag.
 * High-precision by design — every new finding source defaults hard to "no
 * finding" when uncertain.
 */
export const InvariantsConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

// --- v1.0 Runtime ---

export const RuntimeConfigSchema = z.object({
  timeout_per_call: z.int().min(1).default(600),
  max_retries: z.int().min(1).max(10).default(3),
  concurrency: z.int().min(1).max(10).default(8),
  min_confidence: z.int().min(0).max(100).default(70),
  max_stop_iterations: z.int().min(1).max(10).default(3),
});

// --- Other sections ---

/** Per-axis embedding provider config (code or nlp). Provider is required; model, base_url, env_key optional. */
export const EmbeddingProviderConfigSchema = z.object({
  /** Provider identifier (e.g. 'openai', 'voyage', 'qwen', 'local-advanced', or a custom name). */
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

// --- Documentation (Story 54.1: Reference-first documentation) ---

/** Doc-comment kinds extracted by LanguageAdapter.extractDocComments. */
export const DocCommentKindSchema = z.enum([
  'jsdoc', 'tsdoc', 'docstring', 'godoc', 'javadoc', 'xmldoc', 'module_header',
]);

export type DocCommentKind = z.infer<typeof DocCommentKindSchema>;

/** Inline doc-comment extraction config — opt-in, structured comments only. */
export const InlineCommentsConfigSchema = z.object({
  enabled: z.boolean(),
  /** Which doc-comment kinds to extract. Required when enabled=true. */
  kinds: z.array(DocCommentKindSchema).optional(),
  /** Glob patterns for source files to scan. Required when enabled=true. */
  include: z.array(z.string()).optional(),
}).refine(
  (data) => !data.enabled || (data.kinds !== undefined && data.kinds.length > 0),
  { message: 'kinds is required when inline_comments is enabled', path: ['kinds'] },
).refine(
  (data) => !data.enabled || (data.include !== undefined && data.include.length > 0),
  { message: 'include is required when inline_comments is enabled', path: ['include'] },
);

export type InlineCommentsConfig = z.infer<typeof InlineCommentsConfigSchema>;

/** Reference documentation config — paths to human-authored docs. */
export const ReferenceDocsConfigSchema = z.object({
  /** Glob patterns for reference documentation files. At least one required. */
  paths: z.array(z.string()).min(1, 'at least one reference path is required'),
  /** Inline doc-comment extraction settings. */
  inline_comments: InlineCommentsConfigSchema.default({ enabled: false }),
  /** Map from doc page name (key) to source module globs (values). */
  module_mapping: z.record(z.string(), z.array(z.string())).optional(),
}).refine(
  (data) => data.paths.every((p) => !p.startsWith('/') && !p.startsWith('\\') && !p.includes('..')),
  { message: 'reference paths must be relative (no leading / or \\, no ..)', path: ['paths'] },
);

export type ReferenceDocsConfig = z.infer<typeof ReferenceDocsConfigSchema>;

/** Internal docs full-mode config. */
export const InternalDocsFullConfigSchema = z.object({
  sync_to_repo: z.boolean(),
});

export type InternalDocsFullConfig = z.infer<typeof InternalDocsFullConfigSchema>;

/**
 * Internal documentation config — `mode` selects the pipeline:
 * - `lite`: no artefact. Reference docs (`reference.paths`) are retrieved
 *   per-file via RAG at review time and injected as authoritative ground
 *   truth. Assumes the docs are maintained and current. No sub-config.
 * - `full`: LLM-curated per-module pages under `.anatoly/state/internal-docs/`
 *   with 3-way coherence + arbitration between reference / internal / code.
 * - `off`: no reference docs injected at all.
 */
export const InternalDocsConfigSchema = z.object({
  /** Documentation generation mode. No default — must be explicitly chosen. */
  mode: z.enum(['full', 'lite', 'off']),
  /** Required when mode=full. */
  full: InternalDocsFullConfigSchema.optional(),
}).refine(
  (data) => data.mode !== 'full' || data.full !== undefined,
  { message: 'internal.full is required when mode is "full"', path: ['full'] },
);

export type InternalDocsConfig = z.infer<typeof InternalDocsConfigSchema>;

/** Top-level documentation config — reference (human) + internal (derived). */
export const DocumentationConfigSchema = z.object({
  reference: ReferenceDocsConfigSchema,
  internal: InternalDocsConfigSchema,
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
  scan: ScanConfigSchema.default({ include: [], exclude: ['node_modules/**', 'dist/**'], respect_gitignore: true, vendored: [] }),
  coverage: CoverageConfigSchema.default({
    enabled: true,
    command: 'npx vitest run --coverage.reporter=json',
    report_path: 'coverage/coverage-final.json',
  }),
  // v2.0 sections
  providers: ProvidersConfigSchema.default({ anthropic: { mode: 'subscription', concurrency: 8 } }),
  models: ModelsConfigSchema.default({
    quality: DEFAULT_MODELS.quality,
    fast: DEFAULT_MODELS.fast,
    deliberation: DEFAULT_MODELS.deliberation,
  }),
  agents: AgentsConfigSchema.default({ enabled: true, max_turns: 30 }),
  invariants: InvariantsConfigSchema.default({ enabled: false }),
  commands: CommandsConfigSchema.optional(),
  runtime: RuntimeConfigSchema.default({
    timeout_per_call: 600,
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
  // Required — Story 54.1 FR1/FR2: no magic defaults. Users must declare
  // their reference paths and internal mode explicitly via `anatoly init`
  // or `anatoly init --reconfigure-docs`. A missing block fails the load
  // with an actionable error pointing to the wizard.
  documentation: DocumentationConfigSchema,
  search: SearchConfigSchema.default({}),
  notifications: NotificationsConfigSchema.optional(),
});

// --- Exported types ---

export type AxisConfig = z.infer<typeof AxisConfigSchema>;
export type GenericProviderConfig = z.infer<typeof GenericProviderConfigSchema>;
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfigSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type InvariantsConfig = z.infer<typeof InvariantsConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type TelegramNotificationConfig = z.infer<typeof TelegramNotificationSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type DocumentationConfig = z.infer<typeof DocumentationConfigSchema>;
export type CommandsConfig = z.infer<typeof CommandsConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Resolve the model a standalone command uses for its LLM calls.
 * Precedence: per-command override (`commands.<command>`) → default
 * (`commands.model`) → `models.quality`. The final fallback is the
 * single-turn quality slot, never `models.deliberation` (the agentic slot),
 * so a command that forgets to configure itself still gets a single-turn
 * capable model.
 */
export function resolveCommandModel(config: Config, command: string): string {
  const c = config.commands;
  const perCommand = c ? (c as Record<string, string | undefined>)[command] : undefined;
  return perCommand ?? c?.model ?? config.models.quality;
}

/**
 * Derive the primary docs directory from reference.paths.
 * Backward-compatible bridge replacing the removed `docs_path` field.
 * Extracts the first directory prefix from glob patterns (e.g. "docs/**\/*.md" → "docs").
 * Returns 'docs' when no directory-like path is found.
 */
export function getDocsDir(config: Config): string {
  const paths = config.documentation?.reference?.paths;
  if (!paths?.length) return 'docs';
  for (const p of paths) {
    // Match directory prefixes like "docs/", "docs/**/*.md", "site/docs/"
    const match = p.match(/^([^*{[?]+?)\//);
    if (match?.[1]) return match[1];
  }
  return 'docs';
}
