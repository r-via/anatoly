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
});

export const CoverageConfigSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().default('npx vitest run --coverage.reporter=json'),
  report_path: z.string().default('coverage/coverage-final.json'),
});

export const LlmConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-6'),
  index_model: z.string().default('claude-haiku-4-5-20251001'),
  agentic_tools: z.boolean().default(true),
  timeout_per_file: z.int().min(1).default(600),
  max_retries: z.int().min(1).max(10).default(3),
  concurrency: z.int().min(1).max(10).default(4),
  min_confidence: z.int().min(0).max(100).default(70),
  max_stop_iterations: z.int().min(1).max(10).default(3),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export const OutputConfigSchema = z.object({
  max_runs: z.int().min(1).optional(),
});

export const ConfigSchema = z.object({
  project: ProjectConfigSchema.default({
    monorepo: false,
  }),
  scan: ScanConfigSchema.default({
    include: ['src/**/*.ts', 'src/**/*.tsx'],
    exclude: ['node_modules/**', 'dist/**', '**/*.test.ts', '**/*.spec.ts'],
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
    min_confidence: 70,
    max_stop_iterations: 3,
  }),
  rag: RagConfigSchema.default({
    enabled: true,
  }),
  output: OutputConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
