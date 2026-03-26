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
});

export const AxesConfigSchema = z.object({
  utility: AxisConfigSchema.default({ enabled: true }),
  duplication: AxisConfigSchema.default({ enabled: true }),
  correction: AxisConfigSchema.default({ enabled: true }),
  overengineering: AxisConfigSchema.default({ enabled: true }),
  tests: AxisConfigSchema.default({ enabled: true }),
  best_practices: AxisConfigSchema.default({ enabled: true }),
  documentation: AxisConfigSchema.default({ enabled: true }),
});

/** LLM configuration controlling model selection, parallelism, and review behaviour. */
export const LlmConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-6'),
  index_model: z.string().default('claude-haiku-4-5-20251001'),
  fast_model: z.string().optional(),
  /** Enable agentic tool use (file read, grep, glob) during LLM review passes. */
  agentic_tools: z.boolean().default(true),
  timeout_per_file: z.int().min(1).default(600),
  max_retries: z.int().min(1).max(10).default(3),
  /** Maximum number of files reviewed in parallel. */
  concurrency: z.int().min(1).max(10).default(8),
  /** Maximum concurrent Anthropic SDK requests across all files. */
  sdk_concurrency: z.int().min(1).max(32).default(24),
  min_confidence: z.int().min(0).max(100).default(70),
  /** Maximum agentic iterations before the reviewer must produce a final verdict. */
  max_stop_iterations: z.int().min(1).max(10).default(3),
  /** Enable a second-pass deliberation review to reclassify borderline findings. */
  deliberation: z.boolean().default(true),
  /** Model used for the deliberation (second-pass) review. */
  deliberation_model: z.string().default('claude-opus-4-6'),
  axes: AxesConfigSchema.default({
    utility: { enabled: true },
    duplication: { enabled: true },
    correction: { enabled: true },
    overengineering: { enabled: true },
    tests: { enabled: true },
    best_practices: { enabled: true },
    documentation: { enabled: true },
  }),
});

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
  llm: LlmConfigSchema.default({
    model: 'claude-sonnet-4-6',
    index_model: 'claude-haiku-4-5-20251001',
    agentic_tools: true,
    timeout_per_file: 600,
    max_retries: 3,
    concurrency: 4,
    sdk_concurrency: 24,
    min_confidence: 70,
    max_stop_iterations: 3,
    deliberation: true,
    deliberation_model: 'claude-opus-4-6',
    axes: {
      utility: { enabled: true },
      duplication: { enabled: true },
      correction: { enabled: true },
      overengineering: { enabled: true },
      tests: { enabled: true },
      best_practices: { enabled: true },
      documentation: { enabled: true },
    },
  }),
  rag: RagConfigSchema.default({ enabled: true, code_model: 'auto', nlp_model: 'auto', code_weight: 0.6 }),
  logging: LoggingConfigSchema.default({ level: 'warn', pretty: true }),
  output: OutputConfigSchema.default({}),
  badge: BadgeConfigSchema.default({
    enabled: true,
    verdict: false,
    link: 'https://github.com/r-via/anatoly',
  }),
  documentation: DocumentationConfigSchema.default({ docs_path: 'docs' }),
});

export type AxisConfig = z.infer<typeof AxisConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
