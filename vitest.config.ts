import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [
    {
      name: 'raw-md',
      transform(_code: string, id: string) {
        if (id.endsWith('.md')) {
          const content = readFileSync(id, 'utf-8');
          return { code: `export default ${JSON.stringify(content)};`, map: null };
        }
      },
    },
  ],
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
