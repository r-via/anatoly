import tseslint from 'typescript-eslint';
import d1PurityRule from './eslint-rules/d1-purity.js';
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
    files: ['src/core/orchestration/registry/primitives/**/*.ts'],
    ignores: ['**/*.test.ts'],
    plugins: {
      anatoly: { rules: { 'd1-purity': d1PurityRule } },
    },
    rules: {
      'anatoly/d1-purity': 'error',
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
