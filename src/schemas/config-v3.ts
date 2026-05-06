// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Anatoly config schema — v3.
 *
 * Restructures the v2 layout into four explicit sections:
 *
 * - **providers**: single source of truth. Each provider declares its transport
 *   (which client SDK to use), auth method, and the list of models it serves.
 * - **routing**: declarative `slot → <provider>/<model>` assignment, validated
 *   against the providers section. No `auto` keyword — the wizard pins values.
 * - **evaluation**: per-axis switches with optional model overrides.
 * - **runtime**: orchestration knobs (concurrency, agent loop turns, hybrid
 *   search ratio, log rotation, logging).
 *
 * Cross-reference validation runs at parse time:
 * - every `<provider>/<model>` reference must point to a declared model
 * - `auth` and `transport` must be a valid combination
 * - generation slots that imply an agentic loop (`deliberation`) must point to
 *   a transport that supports agentic, not OpenAI-compat
 * - embedding slots must point to a transport in {openai_compatible,
 *   onnxruntime_node}
 *
 * Sections inherited from v2 without restructuring (`project`, `scan`,
 * `coverage`, `badge`, `search`, `notifications`) are re-exported so the
 * top-level schema is self-contained.
 */

import { z } from 'zod';
import {
  ProjectConfigSchema,
  ScanConfigSchema,
  CoverageConfigSchema,
  BadgeConfigSchema,
  SearchConfigSchema,
  NotificationsConfigSchema,
} from './config.js';

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Transport identifies which client SDK is used to talk to the provider. */
export const TransportSchema = z.enum([
  'claude_agent_sdk',         // @anthropic-ai/claude-agent-sdk (agentic + single_turn)
  'google_genai',             // @google/genai (agentic + single_turn)
  'openai_compatible',        // @ai-sdk/openai-compatible (single_turn + embeddings)
  'onnxruntime_node',         // onnxruntime-node (in-process embeddings only)
]);

export type Transport = z.infer<typeof TransportSchema>;

/** Auth method. Only meaningful for transports that talk to a network. */
export const AuthSchema = z.enum(['oauth', 'api_key']);

export type Auth = z.infer<typeof AuthSchema>;

/** Set of transports that can run an agentic loop (multi-turn + tools). */
export const AGENTIC_TRANSPORTS: ReadonlySet<Transport> = new Set([
  'claude_agent_sdk',
  'google_genai',
]);

/** Set of transports that can produce embeddings. */
export const EMBEDDING_TRANSPORTS: ReadonlySet<Transport> = new Set([
  'openai_compatible',
  'onnxruntime_node',
]);

/** Set of transports that talk to a network endpoint (need auth). */
export const NETWORK_TRANSPORTS: ReadonlySet<Transport> = new Set([
  'claude_agent_sdk',
  'google_genai',
  'openai_compatible',
]);

export const ProviderConfigSchema = z.object({
  transport: TransportSchema,
  auth: AuthSchema.optional(),
  /** Environment variable name holding the API key. Required when auth=api_key. */
  env_key: z.string().min(1).optional(),
  /** Override the default endpoint for this provider. */
  base_url: z.string().url().optional(),
  /** Max parallel inflight requests for this provider. */
  concurrency: z.int().min(1).max(128).optional(),
  /** Models this provider serves. Used to validate `routing` references. */
  models: z.array(z.string().min(1)).min(1),
}).superRefine((data, ctx) => {
  const isNetwork = NETWORK_TRANSPORTS.has(data.transport);
  const isOnnx = data.transport === 'onnxruntime_node';

  // Network transports require an auth method.
  if (isNetwork && !data.auth) {
    ctx.addIssue({
      code: 'custom',
      path: ['auth'],
      message: `transport "${data.transport}" requires an auth method (oauth or api_key)`,
    });
  }

  // ONNX is in-process — auth, env_key, base_url are nonsensical.
  if (isOnnx) {
    if (data.auth !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['auth'], message: 'onnxruntime_node has no auth' });
    }
    if (data.env_key !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['env_key'], message: 'onnxruntime_node has no env_key' });
    }
    if (data.base_url !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['base_url'], message: 'onnxruntime_node has no base_url' });
    }
  }

  // openai_compatible only supports api_key (no OAuth flow defined).
  if (data.transport === 'openai_compatible' && data.auth === 'oauth') {
    ctx.addIssue({
      code: 'custom',
      path: ['auth'],
      message: 'openai_compatible does not support oauth — use api_key',
    });
  }

  // api_key requires env_key so we know which env var to read.
  if (data.auth === 'api_key' && !data.env_key) {
    ctx.addIssue({
      code: 'custom',
      path: ['env_key'],
      message: 'auth=api_key requires env_key (e.g. MISTRAL_API_KEY)',
    });
  }

  // oauth must not specify env_key (the session is acquired interactively).
  if (data.auth === 'oauth' && data.env_key !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['env_key'],
      message: 'auth=oauth must not specify env_key (no API key is read)',
    });
  }

  // Models must be unique within a provider.
  const seen = new Set<string>();
  for (const [i, m] of data.models.entries()) {
    if (seen.has(m)) {
      ctx.addIssue({
        code: 'custom',
        path: ['models', i],
        message: `duplicate model "${m}"`,
      });
    }
    seen.add(m);
  }
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** A non-empty record of provider name → provider config. */
export const ProvidersConfigSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]*$/, 'provider id must be lowercase kebab-case'),
  ProviderConfigSchema,
).refine(
  (data) => Object.keys(data).length > 0,
  'at least one provider must be configured',
);

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Parsed `provider/model` reference. */
export interface ModelRef {
  provider: string;
  model: string;
  raw: string;
}

/**
 * Parse a `provider/model` reference. Returns null on malformed input.
 * Multi-segment models like `qwen/qwen3-embedding-8b` are supported — the
 * first segment is always the provider, everything after is the model id.
 */
export function parseModelRef(raw: string): ModelRef | null {
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return null;
  return {
    provider: raw.slice(0, slash),
    model: raw.slice(slash + 1),
    raw,
  };
}

/** A `<provider>/<model>` reference string. Cross-checked at root level. */
export const ModelRefSchema = z.string().refine(
  (v) => parseModelRef(v) !== null,
  'must be in the format <provider>/<model>',
);

export const GenerationRoutingSchema = z.object({
  /** Deep evaluation slot (axes correction, tests, best_practices, documentation). */
  quality: ModelRefSchema,
  /** Cheap evaluation slot (axes utility, duplication, overengineering). */
  fast: ModelRefSchema,
  /** Agentic deliberation slot (tier 3 investigation, doc generation). */
  deliberation: ModelRefSchema,
  /** Function-summary slot (NLP RAG indexing). */
  summarization: ModelRefSchema,
});

export type GenerationRouting = z.infer<typeof GenerationRoutingSchema>;

export const EmbeddingsRoutingSchema = z.object({
  /** Code-direct embedding model (signature + body). */
  code: ModelRefSchema,
  /** Natural-language embedding model (function summaries + doc chunks). */
  text: ModelRefSchema,
});

export type EmbeddingsRouting = z.infer<typeof EmbeddingsRoutingSchema>;

export const RoutingConfigSchema = z.object({
  generation: GenerationRoutingSchema,
  embeddings: EmbeddingsRoutingSchema,
});

export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

// ---------------------------------------------------------------------------
// Evaluation (per-axis switches with optional overrides)
// ---------------------------------------------------------------------------

/** Long-form axis config (object with overrides). */
export const AxisObjectSchema = z.object({
  enabled: z.boolean().default(true),
  /** Override the routing slot for this axis. */
  model: ModelRefSchema.optional(),
  /** Glob patterns to skip on this axis. */
  skip: z.array(z.string()).optional(),
});

export type AxisObject = z.infer<typeof AxisObjectSchema>;

/**
 * Axis can be either:
 * - `true` / `false` (enabled flag, all overrides default)
 * - an object with `enabled` and optional `model`, `skip`, axis-specific keys
 */
export const AxisSchema = z.union([z.boolean(), AxisObjectSchema]);

export type Axis = z.infer<typeof AxisSchema>;

/** Documentation axis carries extra fields (docs_path, module_mapping). */
export const DocumentationAxisSchema = AxisObjectSchema.extend({
  docs_path: z.string().default('docs'),
  /** Map from doc page (key) to source globs (values). */
  module_mapping: z.record(z.string(), z.array(z.string())).optional(),
});

export type DocumentationAxis = z.infer<typeof DocumentationAxisSchema>;

/** Documentation axis can also be the bool short form. */
export const DocumentationAxisFieldSchema = z.union([z.boolean(), DocumentationAxisSchema]);

export const EvaluationAxesSchema = z.object({
  utility: AxisSchema.default(true),
  duplication: AxisSchema.default(true),
  correction: AxisSchema.default(true),
  overengineering: AxisSchema.default(true),
  tests: AxisSchema.default(true),
  best_practices: AxisSchema.default(true),
  documentation: DocumentationAxisFieldSchema.default(true),
});

export type EvaluationAxes = z.infer<typeof EvaluationAxesSchema>;

export const EvaluationConfigSchema = z.object({
  axes: EvaluationAxesSchema.default({
    utility: true,
    duplication: true,
    correction: true,
    overengineering: true,
    tests: true,
    best_practices: true,
    documentation: true,
  }),
});

export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export const AgentsRuntimeSchema = z.object({
  /** Cap on agentic turns (tier 3 investigation, doc generation). */
  max_turns: z.int().min(1).max(200).default(30),
});

export const RagRuntimeSchema = z.object({
  /** Share of the code-embedding score in the hybrid search ranking (0..1).
   *  text_share is implicitly `1 - code_share`. */
  code_share: z.number().min(0).max(1).default(0.6),
  /** When the LanceDB table holds vectors of a different dimension than the
   *  active embedding model produces (e.g. user switched backend or the model
   *  registry was updated), drop and recreate the table on the next indexing
   *  run instead of warning and continuing with mismatched data. Default
   *  true — leaving stale dims in place produces silently-wrong search
   *  results downstream, so auto-healing is the safer default. */
  rebuild_on_drift: z.boolean().default(true),
});

export const OutputRuntimeSchema = z.object({
  /** Cap on retained run logs in `.anatoly/runs/`. Older runs are pruned. */
  max_runs: z.int().min(1).optional(),
});

export const LoggingRuntimeSchema = z.object({
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('warn'),
  pretty: z.boolean().default(true),
  /** Optional file sink. */
  file: z.string().optional(),
});

export const RuntimeConfigSchema = z.object({
  /** Max parallel files in the evaluation pipeline. */
  concurrency: z.int().min(1).max(64).default(8),
  /** Per-file timeout in seconds for the evaluation pipeline. */
  timeout_per_file: z.int().min(1).default(600),
  /** Retry budget for transient transport errors. */
  max_retries: z.int().min(1).max(10).default(3),
  /** Minimum confidence threshold for hook-mode auto-stop (0..100). */
  min_confidence: z.int().min(0).max(100).default(70),
  /** Hard cap on hook-mode self-iteration loops. */
  max_stop_iterations: z.int().min(1).max(10).default(3),
  agents: AgentsRuntimeSchema.default({ max_turns: 30 }),
  rag: RagRuntimeSchema.default({ code_share: 0.6, rebuild_on_drift: true }),
  output: OutputRuntimeSchema.default({}),
  logging: LoggingRuntimeSchema.default({ level: 'warn', pretty: true }),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

const PreConfigSchema = z.object({
  version: z.literal(3),
  // Sections inherited unchanged from v2.
  project: ProjectConfigSchema.default({ monorepo: false }),
  scan: ScanConfigSchema.default({ include: [], exclude: ['node_modules/**', 'dist/**'], respect_gitignore: true }),
  coverage: CoverageConfigSchema.default({
    enabled: true,
    command: 'npx vitest run --coverage.reporter=json',
    report_path: 'coverage/coverage-final.json',
  }),
  badge: BadgeConfigSchema.default({
    enabled: true,
    verdict: false,
    link: 'https://github.com/r-via/anatoly',
  }),
  search: SearchConfigSchema.default({}),
  notifications: NotificationsConfigSchema.optional(),
  // Restructured v3 sections.
  providers: ProvidersConfigSchema,
  routing: RoutingConfigSchema,
  evaluation: EvaluationConfigSchema.default({
    axes: {
      utility: true,
      duplication: true,
      correction: true,
      overengineering: true,
      tests: true,
      best_practices: true,
      documentation: true,
    },
  }),
  runtime: RuntimeConfigSchema.default({
    concurrency: 8,
    timeout_per_file: 600,
    max_retries: 3,
    min_confidence: 70,
    max_stop_iterations: 3,
    agents: { max_turns: 30 },
    rag: { code_share: 0.6, rebuild_on_drift: true },
    output: {},
    logging: { level: 'warn', pretty: true },
  }),
});

/**
 * Iterate every model reference in the config and run a callback. Used by
 * cross-reference validation to keep the validator close to the schema.
 */
function* iterateModelRefs(
  data: z.infer<typeof PreConfigSchema>,
): Generator<{ ref: string; path: (string | number)[] }> {
  const r = data.routing;
  yield { ref: r.generation.quality, path: ['routing', 'generation', 'quality'] };
  yield { ref: r.generation.fast, path: ['routing', 'generation', 'fast'] };
  yield { ref: r.generation.deliberation, path: ['routing', 'generation', 'deliberation'] };
  yield { ref: r.generation.summarization, path: ['routing', 'generation', 'summarization'] };
  yield { ref: r.embeddings.code, path: ['routing', 'embeddings', 'code'] };
  yield { ref: r.embeddings.text, path: ['routing', 'embeddings', 'text'] };

  for (const [axisId, axis] of Object.entries(data.evaluation.axes)) {
    if (typeof axis === 'object' && axis !== null && 'model' in axis && axis.model) {
      yield { ref: axis.model, path: ['evaluation', 'axes', axisId, 'model'] };
    }
  }
}

/**
 * Cross-reference validation: every model ref points to a declared model, and
 * every routing slot uses a transport that supports its purpose.
 */
export const ConfigV3Schema = PreConfigSchema.superRefine((data, ctx) => {
  const providers = data.providers;

  // 1. Every <provider>/<model> reference resolves to a declared model.
  for (const { ref, path } of iterateModelRefs(data)) {
    const parsed = parseModelRef(ref);
    if (!parsed) continue; // already flagged by ModelRefSchema regex
    const provider = providers[parsed.provider];
    if (!provider) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `provider "${parsed.provider}" not declared in providers section`,
      });
      continue;
    }
    if (!provider.models.includes(parsed.model)) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `model "${parsed.model}" not declared under providers.${parsed.provider}.models`,
      });
    }
  }

  // 2. Routing-slot transport capability checks.
  const checkTransport = (
    refKey: string,
    ref: string,
    requirement: 'agentic' | 'single_turn' | 'embeddings',
  ): void => {
    const parsed = parseModelRef(ref);
    if (!parsed) return;
    const provider = providers[parsed.provider];
    if (!provider) return;
    const t = provider.transport;
    if (requirement === 'agentic' && !AGENTIC_TRANSPORTS.has(t)) {
      ctx.addIssue({
        code: 'custom',
        path: refKey.split('.'),
        message: `slot "${refKey}" requires an agentic-capable transport (claude_agent_sdk, google_genai); "${parsed.provider}" uses ${t}`,
      });
    }
    if (requirement === 'embeddings' && !EMBEDDING_TRANSPORTS.has(t)) {
      ctx.addIssue({
        code: 'custom',
        path: refKey.split('.'),
        message: `slot "${refKey}" requires an embedding-capable transport (openai_compatible, onnxruntime_node); "${parsed.provider}" uses ${t}`,
      });
    }
    if (requirement === 'single_turn' && t === 'onnxruntime_node') {
      ctx.addIssue({
        code: 'custom',
        path: refKey.split('.'),
        message: `slot "${refKey}" requires a single-turn LLM transport; "${parsed.provider}" uses onnxruntime_node which is embeddings-only`,
      });
    }
  };

  checkTransport('routing.generation.quality',       data.routing.generation.quality,       'single_turn');
  checkTransport('routing.generation.fast',          data.routing.generation.fast,          'single_turn');
  checkTransport('routing.generation.summarization', data.routing.generation.summarization, 'single_turn');
  checkTransport('routing.generation.deliberation',  data.routing.generation.deliberation,  'agentic');
  checkTransport('routing.embeddings.code',          data.routing.embeddings.code,          'embeddings');
  checkTransport('routing.embeddings.text',          data.routing.embeddings.text,          'embeddings');
});

export type ConfigV3 = z.infer<typeof ConfigV3Schema>;

// ---------------------------------------------------------------------------
// Helpers re-exported for consumers
// ---------------------------------------------------------------------------

/**
 * Detect if a parsed YAML object is a v3 config. Used by the loader to route
 * to the right schema. Returns true iff the top-level `version` is exactly 3.
 */
export function isV3Config(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === 3;
}

/**
 * Resolve an axis to its concrete (enabled, model?) view. Centralises the
 * bool-or-object normalization so consumers don't repeat the discriminant.
 *
 * @param axis - Raw value from `evaluation.axes.<id>`.
 * @returns `{ enabled, model? }` with `model` being a `<provider>/<model>` ref.
 */
export function resolveAxis(axis: Axis): { enabled: boolean; model?: string; skip?: string[] } {
  if (typeof axis === 'boolean') return { enabled: axis };
  return {
    enabled: axis.enabled,
    ...(axis.model ? { model: axis.model } : {}),
    ...(axis.skip ? { skip: axis.skip } : {}),
  };
}
