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
    // Phase modules render the run summary to stdout today. This is
    // transitional: doc 11 PR 8 routes presentation through a port. Until
    // then, console output here is intentional CLI output, not a smell.
    files: ['src/core/orchestration/phases/**/*.ts'],
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
