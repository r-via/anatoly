# Testing

## Vitest Setup

Anatoly uses [Vitest](https://vitest.dev/) v4 as its test runner. The configuration lives in `vitest.config.ts`:

```ts
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
```

Key settings:

- **`globals: true`** -- `describe`, `it`, `expect`, `vi`, etc. are available without imports (though the codebase often imports them explicitly for clarity).
- **`include`** -- only files matching `src/**/*.test.ts` are collected.
- **`passWithNoTests: true`** -- the suite passes even if no test files are found (useful during early development of new modules).
- **`raw-md` plugin** -- allows importing `.md` files as raw strings in tests, which is used for prompt template testing.

## Test Structure and Conventions

Tests are co-located with their source files:

```
src/core/scanner.ts
src/core/scanner.test.ts

src/core/axes/utility.ts
src/core/axes/utility.test.ts

src/schemas/config.ts
src/schemas/config.test.ts
```

### Naming

- Test files use the `.test.ts` suffix (not `.spec.ts`).
- Top-level `describe` blocks name the module or function under test.
- Individual `it` blocks describe the expected behavior.

### Patterns

- **Schema tests** validate both the happy path (`parse` succeeds) and rejection of invalid input. They use `ConfigSchema.parse(...)` directly.
- **Evaluator tests** test the axis evaluators with mocked LLM responses.
- **Unit tests** for utilities test pure functions with straightforward input/output assertions.

Example from the codebase:

```ts
import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../schemas/config.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse(overrides);
}

describe('resolveAxisModel', () => {
  it('should use config axis model override when specified', () => {
    const config = makeConfig({ llm: { axes: { utility: { model: 'custom-model' } } } });
    // ...assertions
  });
});
```

## Running Tests

```bash
# Run all tests once
pnpm test

# Run tests in watch mode (during development)
pnpm vitest

# Run a specific test file
pnpm vitest src/core/scanner.test.ts

# Run tests matching a pattern
pnpm vitest -t "resolveAxisModel"
```

## Coverage

Vitest supports built-in coverage via `@vitest/coverage-v8`. To generate a coverage report:

```bash
pnpm vitest run --coverage
```

This outputs coverage data to the `coverage/` directory. The project's own audit pipeline expects coverage in `coverage/coverage-final.json` (configurable via `.anatoly.yml`), so coverage from the audited target project and coverage of Anatoly's own tests are independent concerns.

## Test Categories at a Glance

| Area | Files | What They Cover |
|------|-------|-----------------|
| Schemas | `src/schemas/*.test.ts` | Zod parse/reject, defaults, edge cases |
| Axes | `src/core/axes/*.test.ts` | Per-axis evaluator logic |
| Core | `src/core/*.test.ts` | Merger, worker pool, progress, scanner, reporter, etc. |
| Commands | `src/commands/*.test.ts` | CLI command handler behavior |
| Utils | `src/utils/*.test.ts` | Logger, errors, cache, lock, rate limiter, formatting |
| RAG | `src/rag/*.test.ts` | Embedding indexer, orchestrator, vector store |
