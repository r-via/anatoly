/**
 * Ground-truth fixture functions for RAG pipeline evaluation.
 *
 * Each group defines a set of functions with known duplication relationships.
 * The evaluation script uses these to compute precision/recall/F1 scores
 * at various similarity thresholds.
 *
 * Groups:
 *   - DUPLICATE pairs: functions that do the same thing differently
 *   - UNIQUE functions: semantically unrelated
 */

// ---------------------------------------------------------------------------
// Group A: HTTP fetching — semantic duplicates (same intent, different impl)
// ---------------------------------------------------------------------------

export const fetchUserAxios = `
export async function fetchUserProfile(userId: string): Promise<User> {
  const response = await axios.get(\`/api/users/\${userId}\`);
  if (response.status !== 200) {
    throw new HttpError(response.status, 'Failed to fetch user');
  }
  return response.data as User;
}`;

export const getUserFetch = `
export async function getUserData(id: string): Promise<User> {
  const res = await fetch(\`/api/users/\${id}\`);
  if (!res.ok) {
    throw new Error(\`User fetch failed: \${res.status}\`);
  }
  return await res.json() as User;
}`;

// ---------------------------------------------------------------------------
// Group B: Array deduplication — structural duplicates (same algorithm)
// ---------------------------------------------------------------------------

export const deduplicateSet = `
export function deduplicateArray<T>(items: T[]): T[] {
  return [...new Set(items)];
}`;

export const removeDuplicates = `
export function removeDuplicates<T>(list: T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}`;

// ---------------------------------------------------------------------------
// Group C: Retry logic — semantic duplicates with different patterns
// ---------------------------------------------------------------------------

export const retryPromise = `
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}`;

export const exponentialRetry = `
export async function exponentialRetry<T>(
  operation: () => Promise<T>,
  attempts: number = 3,
  initialWait: number = 1000,
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === attempts - 1) throw error;
      await sleep(initialWait * 2 ** i);
    }
  }
  throw new Error('Unreachable');
}`;

// ---------------------------------------------------------------------------
// Group D: Cache — similar pattern (memoization/caching)
// ---------------------------------------------------------------------------

export const memoizeFunction = `
export function memoize<T extends (...args: unknown[]) => unknown>(fn: T): T {
  const cache = new Map<string, ReturnType<T>>();
  return ((...args: unknown[]) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key)!;
    const result = fn(...args) as ReturnType<T>;
    cache.set(key, result);
    return result;
  }) as T;
}`;

export const withCache = `
export function withCache<A extends unknown[], R>(
  fn: (...args: A) => R,
  ttlMs: number = 60000,
): (...args: A) => R {
  const entries = new Map<string, { value: R; expiry: number }>();
  return (...args: A): R => {
    const key = JSON.stringify(args);
    const cached = entries.get(key);
    if (cached && cached.expiry > Date.now()) return cached.value;
    const value = fn(...args);
    entries.set(key, { value, expiry: Date.now() + ttlMs });
    return value;
  };
}`;

// ---------------------------------------------------------------------------
// Group E: Logger — similar structure, different scope
// ---------------------------------------------------------------------------

export const createLogger = `
export function createLogger(prefix: string) {
  return {
    info: (msg: string, data?: Record<string, unknown>) =>
      console.log(\`[\${prefix}] INFO: \${msg}\`, data ?? ''),
    warn: (msg: string, data?: Record<string, unknown>) =>
      console.warn(\`[\${prefix}] WARN: \${msg}\`, data ?? ''),
    error: (msg: string, err?: Error) =>
      console.error(\`[\${prefix}] ERROR: \${msg}\`, err?.message ?? ''),
  };
}`;

export const buildLogger = `
export function buildLogger(namespace: string) {
  const log = (level: string, message: string, meta?: object) =>
    console.log(JSON.stringify({ level, namespace, message, ...meta }));
  return {
    info: (msg: string, meta?: object) => log('info', msg, meta),
    warn: (msg: string, meta?: object) => log('warn', msg, meta),
    error: (msg: string, meta?: object) => log('error', msg, meta),
  };
}`;

// ---------------------------------------------------------------------------
// Unique functions (should NOT match any group above)
// ---------------------------------------------------------------------------

export const parseMarkdown = `
export function parseMarkdown(input: string): ASTNode {
  const tokens = tokenize(input);
  const ast: ASTNode = { type: 'root', children: [] };
  let current = ast;
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        current.children.push({ type: 'heading', level: token.level, text: token.text, children: [] });
        break;
      case 'paragraph':
        current.children.push({ type: 'paragraph', text: token.text, children: [] });
        break;
      case 'code':
        current.children.push({ type: 'code', lang: token.lang, text: token.text, children: [] });
        break;
    }
  }
  return ast;
}`;

export const sortByPriority = `
export function sortByPriority<T extends { priority: number; createdAt: Date }>(
  items: T[],
  direction: 'asc' | 'desc' = 'desc',
): T[] {
  return [...items].sort((a, b) => {
    const diff = direction === 'desc' ? b.priority - a.priority : a.priority - b.priority;
    if (diff !== 0) return diff;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}`;

export const computeChecksum = `
export function computeChecksum(data: Buffer, algorithm: 'sha256' | 'md5' = 'sha256'): string {
  const hash = createHash(algorithm);
  hash.update(data);
  return hash.digest('hex');
}`;

export const debounce = `
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}`;

export const validateEmail = `
export function validateEmail(email: string): { valid: boolean; reason?: string } {
  if (!email || email.length > 254) return { valid: false, reason: 'length' };
  const parts = email.split('@');
  if (parts.length !== 2) return { valid: false, reason: 'format' };
  const [local, domain] = parts;
  if (!local || local.length > 64) return { valid: false, reason: 'local part' };
  if (!domain || !domain.includes('.')) return { valid: false, reason: 'domain' };
  return { valid: true };
}`;

// ---------------------------------------------------------------------------
// Ground truth definition
// ---------------------------------------------------------------------------

export interface EvalFunction {
  id: string;
  name: string;
  source: string;
  group: string; // Functions in the same group are duplicates
}

export const EVAL_FUNCTIONS: EvalFunction[] = [
  // Group A: HTTP fetching
  { id: 'fetchUserAxios', name: 'fetchUserProfile', source: fetchUserAxios, group: 'http-fetch' },
  { id: 'getUserFetch', name: 'getUserData', source: getUserFetch, group: 'http-fetch' },

  // Group B: Array dedup
  { id: 'deduplicateSet', name: 'deduplicateArray', source: deduplicateSet, group: 'dedup' },
  { id: 'removeDuplicates', name: 'removeDuplicates', source: removeDuplicates, group: 'dedup' },

  // Group C: Retry
  { id: 'retryPromise', name: 'retryWithBackoff', source: retryPromise, group: 'retry' },
  { id: 'exponentialRetry', name: 'exponentialRetry', source: exponentialRetry, group: 'retry' },

  // Group D: Cache/memoize
  { id: 'memoizeFunction', name: 'memoize', source: memoizeFunction, group: 'cache' },
  { id: 'withCache', name: 'withCache', source: withCache, group: 'cache' },

  // Group E: Logger
  { id: 'createLogger', name: 'createLogger', source: createLogger, group: 'logger' },
  { id: 'buildLogger', name: 'buildLogger', source: buildLogger, group: 'logger' },

  // Unique functions (each in its own group — no duplicates)
  { id: 'parseMarkdown', name: 'parseMarkdown', source: parseMarkdown, group: 'unique-markdown' },
  { id: 'sortByPriority', name: 'sortByPriority', source: sortByPriority, group: 'unique-sort' },
  { id: 'computeChecksum', name: 'computeChecksum', source: computeChecksum, group: 'unique-hash' },
  { id: 'debounce', name: 'debounce', source: debounce, group: 'unique-debounce' },
  { id: 'validateEmail', name: 'validateEmail', source: validateEmail, group: 'unique-email' },
];

/**
 * Build the ground truth set of duplicate pairs from the fixture definitions.
 * Two functions are duplicates if they share the same group (excluding singleton groups).
 */
export function buildGroundTruth(): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < EVAL_FUNCTIONS.length; i++) {
    for (let j = i + 1; j < EVAL_FUNCTIONS.length; j++) {
      if (EVAL_FUNCTIONS[i].group === EVAL_FUNCTIONS[j].group) {
        pairs.add(pairKey(EVAL_FUNCTIONS[i].id, EVAL_FUNCTIONS[j].id));
      }
    }
  }
  return pairs;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}
