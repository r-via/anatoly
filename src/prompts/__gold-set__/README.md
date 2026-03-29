# Gold-Set Integration Tests

Validates prompt reinforcements (Epic 34) via real LLM calls on carefully selected edge cases.

## Fixtures

| File | Edge Case | Axis | Expected Result |
|------|-----------|------|-----------------|
| `empty-file.ts` | No symbols | all per-symbol | `{ "symbols": [] }` for all axes |
| `generated-protobuf.ts` | `@generated` header | best-practices | Lenient scoring, score >= 5.0 |
| `monolith-500-lines.ts` | 500+ lines, 20 functions | utility | All symbols covered, no truncation |
| `mixed-lang-sql.ts` | SQL in template literals | best-practices | SQL not penalized as TypeScript |
| `perfect-10.ts` | Exemplary code | best-practices | score >= 9.0 |
| `terrible-1.ts` | `any`, `eval`, secrets | best-practices | score <= 3.0 |
| `dead-code.ts` | Orphan exports | utility | utility = DEAD |
| `false-duplicate.ts` | Similar structure, different semantics | duplication | duplication = UNIQUE |
| `correction-bugs.ts` | Clean + buggy + critical | correction | OK, NEEDS_FIX, ERROR |
| `overengineered.ts` | Simple vs factory-pattern | overengineering | LEAN vs OVER |
| `weak-tests.ts` | Happy-path-only tests | tests | tests = WEAK |
| `undocumented.ts` | Full JSDoc vs none | documentation | DOCUMENTED vs UNDOCUMENTED |
| `true-duplicate.ts` | Identical logic, different names | duplication | duplication = DUPLICATE |
| `used-symbols.ts` | Actively imported symbols | utility | utility = USED (no false DEAD) |

## Running

```bash
# Run all gold-set tests (requires Claude API access)
npx vitest run src/prompts/__gold-set__/gold-set.test.ts

# With a specific model
GOLD_SET_MODEL=claude-sonnet-4-5-20250514 npx vitest run src/prompts/__gold-set__/gold-set.test.ts
```

## Cost

Estimated ~$2.00 per full run with Haiku model:
- 14 files x targeted axes = ~34 LLM calls
- ~$0.02 per call (Haiku)
- Manual execution only (not included in CI or `npm run test`)

## Exclusion

These tests are excluded from the normal test suite via `vitest.config.ts`:
```typescript
exclude: ['src/prompts/__gold-set__/**']
```

The `__gold-set__` directory is also excluded from `tsconfig.json` to allow
intentionally bad TypeScript in fixtures like `terrible-1.ts`.

## Baseline

After running the tests, save the results to `baseline.json` for regression tracking.
