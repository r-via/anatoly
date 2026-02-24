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
  model: z.string().default('claude-sonnet-4-20250514'),
  agentic_tools: z.boolean().default(true),
  timeout_per_file: z.int().min(1).default(180),
  max_retries: z.int().min(1).max(10).default(3),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(false),
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
    model: 'claude-sonnet-4-20250514',
    agentic_tools: true,
    timeout_per_file: 180,
    max_retries: 3,
  }),
  rag: RagConfigSchema.default({
    enabled: false,
  }),
  output: OutputConfigSchema.default({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ScanConfig = z.infer<typeof ScanConfigSchema>;
export type CoverageConfig = z.infer<typeof CoverageConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type RagConfig = z.infer<typeof RagConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
