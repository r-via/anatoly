import { describe, it, expect } from 'vitest';
import { ProgressSchema, FileProgressSchema } from './progress.js';

describe('ProgressSchema', () => {
  it('should validate a valid progress object', () => {
    const progress = {
      version: 1,
      started_at: '2026-02-23T10:00:00Z',
      files: {
        'src/index.ts': {
          file: 'src/index.ts',
          hash: 'abc123def456',
          status: 'PENDING',
          updated_at: '2026-02-23T10:00:00Z',
        },
        'src/utils/format.ts': {
          file: 'src/utils/format.ts',
          hash: 'def789ghi012',
          status: 'DONE',
          updated_at: '2026-02-23T10:05:00Z',
        },
      },
    };
    const result = ProgressSchema.safeParse(progress);
    expect(result.success).toBe(true);
  });

  it('should accept all valid statuses', () => {
    const statuses = ['PENDING', 'IN_PROGRESS', 'DONE', 'TIMEOUT', 'ERROR', 'CACHED'] as const;
    for (const status of statuses) {
      const result = FileProgressSchema.safeParse({
        file: 'test.ts',
        hash: 'abc',
        status,
        updated_at: '2026-02-23T10:00:00Z',
      });
      expect(result.success).toBe(true);
    }
  });

  it('should allow optional error field on FileProgress', () => {
    const result = FileProgressSchema.safeParse({
      file: 'test.ts',
      hash: 'abc',
      status: 'ERROR',
      updated_at: '2026-02-23T10:00:00Z',
      error: 'Zod validation failed after 3 retries',
    });
    expect(result.success).toBe(true);
  });
});
