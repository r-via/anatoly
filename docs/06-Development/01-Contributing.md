# Contributing

## Dev Setup

```bash
git clone https://github.com/r-via/anatoly.git
cd anatoly
pnpm install
pnpm build
```

**Prerequisites:**

- Node.js >= 20.19
- pnpm (package manager)
- An `ANTHROPIC_API_KEY` environment variable for integration tests and local runs

The `postinstall` script (`node scripts/download-model.js`) runs automatically after `pnpm install` to fetch required model assets.

### Useful Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `pnpm dev` | Run from source via `tsx` |
| `build` | `pnpm build` | Production build via `tsup` |
| `test` | `pnpm test` | Run all tests via Vitest |
| `lint` | `pnpm lint` | ESLint check on `src/` |
| `typecheck` | `pnpm typecheck` | `tsc --noEmit` strict type check |

## Code Conventions

### Strict TypeScript, ESM-Only

The project is pure ESM (`"type": "module"` in package.json). The TypeScript configuration enforces:

- `"strict": true` -- all strict checks enabled
- `"module": "NodeNext"` / `"moduleResolution": "NodeNext"` -- native ESM resolution
- `"target": "ES2022"`

All imports must use the `.js` extension (NodeNext resolution requires it even for `.ts` source files):

```ts
import { ConfigSchema } from '../schemas/config.js';
```

### ESLint

The project uses the flat config format (`eslint.config.js`) with `typescript-eslint`:

- `@typescript-eslint/no-unused-vars` is set to `error` (unused args prefixed with `_` are allowed)
- `no-console` is enforced as `error` in `src/core/**/*.ts` (non-test files) -- use the `pino` logger instead

### General Style

- Prefer `z.infer<typeof Schema>` for deriving types from Zod schemas -- never duplicate type definitions manually.
- Use the `AnatolyError` class and `ERROR_CODES` enum from `src/utils/errors.ts` for domain errors.
- Co-locate tests next to their source file (`scanner.ts` / `scanner.test.ts`).

## Project Structure

```
src/
  index.ts              # CLI entry point
  cli.ts                # Commander command definitions
  commands/             # Top-level CLI command handlers
    run.ts, status.ts, report.ts, review.ts, estimate.ts, ...
  core/                 # Business logic
    scanner.ts          # File discovery and AST task creation
    file-evaluator.ts   # Orchestrates per-file axis evaluation
    axis-evaluator.ts   # AxisEvaluator interface and shared helpers
    axis-merger.ts      # Merges per-axis results into a ReviewFile
    worker-pool.ts      # Concurrent file processing
    progress-manager.ts # Run state persistence
    reporter.ts         # Summary report generation
    badge.ts            # README badge injection
    deliberation.ts     # Optional deliberation pass
    triage.ts           # Priority triage logic
    usage-graph.ts      # Cross-file usage analysis
    axes/               # One evaluator per review axis
      utility.ts, duplication.ts, correction.ts,
      overengineering.ts, tests.ts, best-practices.ts
      prompts/          # LLM prompt templates
      index.ts          # Evaluator registry
  schemas/              # Zod schemas (source of truth for all data shapes)
    task.ts, review.ts, config.ts, progress.ts
  rag/                  # Retrieval-augmented generation (embeddings, indexing)
    embeddings.ts, indexer.ts, orchestrator.ts
  utils/                # Shared utilities
    logger.ts, errors.ts, cache.ts, lock.ts, format.ts, ...
  types/                # Ambient type declarations
```

## PR Workflow

1. Create a feature branch off `main`.
2. Make your changes. Ensure all of the following pass:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
3. Open a pull request against `main`.
4. PRs require review before merging.

## How to Add a New Axis Evaluator

Anatoly's review pipeline is axis-based. Each axis evaluates files independently, and results are merged into a single `ReviewFile`. To add a new axis:

### 1. Define the axis ID

Add the new ID to the `AxisId` type in `src/core/axis-evaluator.ts`:

```ts
export type AxisId =
  | 'utility'
  | 'duplication'
  // ...existing axes...
  | 'my_new_axis';
```

Also add it to `AxisIdSchema` in `src/schemas/review.ts` and to `ALL_AXIS_IDS` in `src/core/axes/index.ts`.

### 2. Add the axis config

In `src/schemas/config.ts`, add the new axis to `AxesConfigSchema`:

```ts
export const AxesConfigSchema = z.object({
  // ...existing axes...
  my_new_axis: AxisConfigSchema.default({ enabled: true }),
});
```

Update the `LlmConfigSchema` default accordingly.

### 3. Implement the evaluator

Create `src/core/axes/my-new-axis.ts` implementing the `AxisEvaluator` interface:

```ts
import type { AxisEvaluator, AxisContext, AxisResult } from '../axis-evaluator.js';

export class MyNewAxisEvaluator implements AxisEvaluator {
  readonly id = 'my_new_axis' as const;
  readonly defaultModel = 'sonnet'; // or 'haiku'

  async evaluate(ctx: AxisContext, abort: AbortController): Promise<AxisResult> {
    // Build your prompt, call the LLM, parse the response.
    // Return an AxisResult with symbols, actions, cost, duration, etc.
  }
}
```

### 4. Register it

In `src/core/axes/index.ts`, import and add your evaluator to the `ALL_EVALUATORS` array. Order matters -- evaluators run sequentially per file.

### 5. Extend the review schema (if needed)

If your axis produces file-level data beyond the standard `SymbolReview` fields, add an optional field to `ReviewFileSchema` in `src/schemas/review.ts`, similar to how `best_practices` was added.

### 6. Write tests

Create `src/core/axes/my-new-axis.test.ts` co-located with the implementation. Test both the evaluator logic and the schema validation of its output.
