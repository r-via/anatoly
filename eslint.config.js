import tseslint from 'typescript-eslint';
import d3EventPurityRule from './eslint-rules/d3-event-purity.js';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'src/prompts/__gold-set__/'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/**/*.test.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // The spine (pipeline.ts) and phase modules emit CLI output directly:
    // interrupt summaries, progress, the run summary. This is intentional
    // user-facing output moved verbatim out of the run command, not a smell.
    // Routing it through a presentation port is possible future cleanup,
    // explicitly out of scope for the move-only extraction (doc 11).
    files: ['src/core/orchestration/phases/**/*.ts', 'src/core/orchestration/pipeline.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['src/core/**/*.ts'],
    ignores: ['**/*.test.ts'],
    plugins: {
      'anatoly-d3': { rules: { 'd3-event-purity': d3EventPurityRule } },
    },
    rules: {
      'anatoly-d3/d3-event-purity': 'error',
    },
  },
);
