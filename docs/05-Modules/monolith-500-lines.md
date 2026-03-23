# monolith-500-lines

> Gold-set test fixture providing a realistic 879-line TypeScript data-transformation utility module used to validate symbol-complete evaluation of large files.

## Overview

`src/prompts/__gold-set__/monolith-500-lines.ts` is a 879-line TypeScript source file that exports 22 symbols: 2 interfaces and 20 functions spanning six utility domains. Within the `@r-via/anatoly` audit pipeline it serves two roles simultaneously:

1. **Realistic codebase sample.** The file is a self-contained, production-grade utility library with comprehensive JSDoc, runtime type guards, and edge-case handling — representative of the kind of TypeScript modules the audit agent encounters in real projects.

2. **Gold-set integration fixture.** The `Gold-Set: monolith-500-lines.ts → all symbols covered` test suite uses this file to assert that the utility axis evaluator returns coverage for every exported function without truncation when processing a file that exceeds 500 lines.

The file is intentionally large: it exists to surface any context-window or prompt-truncation issues that would cause the LLM to silently drop symbols from its output.

**File:** `src/prompts/__gold-set__/monolith-500-lines.ts`
**Lines:** 879
**Exported symbols:** 22 (2 interfaces, 20 functions)

---

## Exported Types

### `RetryOptions`

Configuration object consumed by [`retry`](#retry).

```typescript
export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
}
```

| Field | Type | Description |
|---|---|---|
| `maxAttempts` | `number` | Maximum number of attempts (≥ 1). |
| `initialDelayMs` | `number` | Delay in ms before the first retry. |
| `maxDelayMs` | `number` | Upper bound on inter-retry delay in ms. |
| `shouldRetry` | `(error: unknown) => boolean` | Optional predicate; return `false` to bail immediately. Defaults to always retrying. |

---

### `PaginateResult<T>`

Result wrapper returned by [`paginate`](#paginate).

```typescript
export interface PaginateResult<T> {
  data: T[];
  total: number;
  page: number;
  totalPages: number;
}
```

| Field | Type | Description |
|---|---|---|
| `data` | `T[]` | Items for the requested page. |
| `total` | `number` | Total items in the full dataset. |
| `page` | `number` | 1-based page number that was retrieved. |
| `totalPages` | `number` | Total pages given the requested size. |

---

## API Reference

### Object Utilities

#### `deepClone`

```typescript
function deepClone<T>(obj: T): T
```

Creates a deep clone using the platform-native `structuredClone` API. Handles nested objects, arrays, `Map`, `Set`, `Date`, and `RegExp`. Throws `DOMException` if `obj` contains non-cloneable values (functions, DOM nodes).

---

#### `pick`

```typescript
function pick<T extends Record<string, unknown>>(
  obj: T,
  keys: (keyof T)[],
): Partial<T>
```

Returns a new object containing only the specified keys. Keys absent from `obj` are silently ignored.

---

#### `omit`

```typescript
function omit<T extends Record<string, unknown>>(
  obj: T,
  keys: (keyof T)[],
): Partial<T>
```

Returns a new object with the specified keys removed. All other own-enumerable properties are included in the result.

---

### Array Utilities

#### `groupBy`

```typescript
function groupBy<T extends Record<string, unknown>>(
  arr: T[],
  key: keyof T,
): Record<string, T[]>
```

Groups array elements into a record keyed by the string value of `key`. Each record entry contains all elements sharing that key value.

---

#### `chunk`

```typescript
function chunk<T>(arr: T[], size: number): T[][]
```

Splits `arr` into sub-arrays of at most `size` elements. The final chunk may be smaller if the array length is not evenly divisible. Throws `RangeError` if `size < 1`.

---

#### `flatten`

```typescript
function flatten<T>(arr: (T | T[])[]): T[]
```

Flattens one level of array nesting. Nested array elements are spread into the result; all other elements are kept as-is.

---

#### `uniqueBy`

```typescript
function uniqueBy<T extends Record<string, unknown>>(
  arr: T[],
  key: keyof T,
): T[]
```

Removes duplicate elements based on the value of `key`. The first occurrence is retained; subsequent duplicates are discarded.

---

#### `sortBy`

```typescript
function sortBy<T extends Record<string, unknown>>(
  arr: T[],
  key: keyof T,
  order: 'asc' | 'desc' = 'asc',
): T[]
```

Returns a sorted copy of `arr` ordered by `key`. The original array is not mutated. `null` / `undefined` values sort last regardless of direction. String comparison uses `localeCompare`.

---

#### `paginate`

```typescript
function paginate<T>(
  arr: T[],
  page: number,
  size: number,
): PaginateResult<T>
```

Returns the slice of `arr` corresponding to 1-based `page` at `size` items per page, along with total and `totalPages` metadata. Out-of-range `page` values are clamped to `[1, totalPages]`.

---

### Async Utilities

#### `retry`

```typescript
async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T>
```

Executes `fn` with exponential backoff and ±10 % jitter. The inter-attempt delay doubles after each failure, capped at `opts.maxDelayMs`. If `opts.shouldRetry` returns `false` for an error, the error is re-thrown immediately without exhausting remaining attempts.

---

### Memoization

#### `memoize`

```typescript
function memoize<T extends (...args: unknown[]) => unknown>(fn: T): T
```

Returns a memoized wrapper for `fn`. Results are cached in a `Map` keyed by `JSON.stringify(args)`. If argument serialization fails (e.g. circular reference), `fn` is called directly and the result is not cached.

---

### String Utilities

#### `truncate`

```typescript
function truncate(str: string, maxLen: number, suffix?: string): string
```

Truncates `str` to `maxLen` characters. Appends `suffix` (default `"..."`) when truncation occurs. The returned string never exceeds `maxLen` characters in total length.

---

#### `camelToSnake`

```typescript
function camelToSnake(str: string): string
```

Converts camelCase or PascalCase to `snake_case`. Treats consecutive uppercase letters as acronyms — `"parseJSON"` → `"parse_json"`.

---

#### `snakeToCamel`

```typescript
function snakeToCamel(str: string): string
```

Converts `snake_case` to camelCase. Leading underscores are preserved; consecutive underscores are collapsed into a single word boundary.

---

### URL / Query String Utilities

#### `parseQueryString`

```typescript
function parseQueryString(qs: string): Record<string, string>
```

Parses a URL query string into a plain object. Accepts strings with or without a leading `"?"`. Duplicate keys resolve to the last occurrence. Malformed percent-encoded sequences are silently skipped.

---

#### `buildQueryString`

```typescript
function buildQueryString(
  params: Record<string, string | number | boolean>,
): string
```

Encodes `params` into a URL query string. Keys are sorted before encoding for deterministic output. The returned string does **not** include a leading `"?"`.

---

### Validation

#### `isValidEmail`

```typescript
function isValidEmail(email: string): boolean
```

Returns `true` if `email` matches a practical email format (not full RFC 5322). Enforces local-part ≤ 64 characters, domain ≤ 253 characters, no consecutive dots, and a TLD of at least two alphabetic characters.

---

### Hashing

#### `hashCode`

```typescript
function hashCode(input: string): number
```

Computes a non-negative 32-bit djb2 hash of `input`. **Not cryptographically secure** — intended for fast bucketing and non-security-sensitive fingerprinting only.

---

### Numeric Utilities

#### `clamp`

```typescript
function clamp(value: number, min: number, max: number): number
```

Returns `value` clamped to the inclusive range `[min, max]`. Throws `RangeError` if `min > max`.

---

### Template Interpolation

#### `interpolate`

```typescript
function interpolate(
  template: string,
  vars: Record<string, string | number>,
): string
```

Replaces `{{key}}` placeholders in `template` with corresponding values from `vars`. Tolerates optional whitespace inside braces (`{{ key }}` and `{{key}}` are equivalent). Unresolved placeholders are left unchanged in the output.

---

## Gold-Set Integration Context

The following test in `src/prompts/__gold-set__/gold-set.test.ts` uses this fixture to verify that the utility axis evaluator processes all exported symbols without truncation:

```typescript
describe('Gold-Set: monolith-500-lines.ts → all symbols covered', () => {
  it('utility axis evaluates all 20 functions without truncation', async () => {
    const content = readFixture('monolith-500-lines.ts');

    const funcNames = content
      .split('\n')
      .filter((line) => /^export (?:async )?function /.test(line))
      .map((line) => line.match(/export (?:async )?function (\w+)/)?.[1])
      .filter(Boolean) as string[];

    expect(funcNames.length).toBeGreaterThanOrEqual(20);

    const symbols: SymbolDef[] = funcNames.map((name) => ({
      exported: true,
      kind: 'function',
      name,
      lineStart: 1,
      lineEnd: 1,
    }));

    const userMsg = buildUserMessage('gold-set/monolith-500-lines.ts', content, symbols);
    const data = await runAxis('utility', userMsg, UtilityResponseSchema);

    // The LLM must return exactly as many symbols as were provided
    expect(data.symbols.length).toBe(funcNames.length);
  }, TIMEOUT);
});
```

If this test fails, it indicates a context-window or prompt-engineering regression in the utility axis evaluator — the model is silently dropping symbols when the source file is large.

---

## Examples

### Object and Array pipeline

```typescript
import {
  deepClone,
  pick,
  groupBy,
  sortBy,
  paginate,
  PaginateResult,
} from './src/prompts/__gold-set__/monolith-500-lines';

interface User {
  id: number;
  name: string;
  role: string;
  score: number;
}

const users: User[] = [
  { id: 1, name: 'Alice', role: 'admin',  score: 92 },
  { id: 2, name: 'Bob',   role: 'viewer', score: 78 },
  { id: 3, name: 'Carol', role: 'admin',  score: 85 },
  { id: 4, name: 'Dave',  role: 'viewer', score: 90 },
];

// Deep-clone before mutation
const snapshot = deepClone(users);

// Retain only public fields
const publicFields = users.map((u) => pick(u, ['id', 'name', 'role']));

// Group by role
const byRole = groupBy(users, 'role');
// { admin: [Alice, Carol], viewer: [Bob, Dave] }

// Sort admins by score descending
const rankedAdmins = sortBy(byRole['admin'], 'score', 'desc');
// [Carol (85), Alice (92)] → [Alice (92), Carol (85)]

// Paginate the full list
const page1: PaginateResult<User> = paginate(users, 1, 2);
// { data: [Alice, Bob], total: 4, page: 1, totalPages: 2 }
```

### Async retry with selective bail-out

```typescript
import { retry, RetryOptions } from './src/prompts/__gold-set__/monolith-500-lines';

const opts: RetryOptions = {
  maxAttempts: 4,
  initialDelayMs: 200,
  maxDelayMs: 2000,
  // Only retry on server errors — bail immediately on 4xx
  shouldRetry: (err) =>
    err instanceof Response ? err.status >= 500 : true,
};

const data = await retry(
  () => fetch('https://api.example.com/data').then((r) => r.json()),
  opts,
);
```

### String and URL utilities

```typescript
import {
  truncate,
  camelToSnake,
  snakeToCamel,
  buildQueryString,
  parseQueryString,
  interpolate,
} from './src/prompts/__gold-set__/monolith-500-lines';

truncate('A very long description that exceeds limits', 20);
// → 'A very long descript...'  (wait: 20 - 3 = 17 chars + "...")
// → 'A very long descr...'

camelToSnake('parseJSONResponse');   // → 'parse_json_response'
snakeToCamel('user_display_name');   // → 'userDisplayName'

const qs = buildQueryString({ page: 2, size: 25, q: 'hello world' });
// → 'page=2&q=hello%20world&size=25'

const params = parseQueryString('?page=2&q=hello%20world&size=25');
// → { page: '2', q: 'hello world', size: '25' }

const msg = interpolate('Hello, {{ name }}! You have {{count}} messages.', {
  name: 'Alice',
  count: 7,
});
// → 'Hello, Alice! You have 7 messages.'
```

---

## See Also

- [Gold-Set Overview](../06-Testing/gold-set.md) — Introduction to all gold-set fixtures and how they are used in integration tests.
- [Utility Axis](./utility-axis.md) — The evaluation axis that processes exported utility functions.
- [Best Practices Axis](./best-practices-axis.md) — Scoring rules that apply to file structure, including file-size penalties.
- [Axis Evaluator](./axis-evaluator.md) — Orchestrator that dispatches source context to each evaluation axis.
