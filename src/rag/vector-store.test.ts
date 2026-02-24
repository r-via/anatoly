import { describe, it, expect } from 'vitest';
import { sanitizeId, sanitizeFilePath } from './vector-store.js';

describe('sanitizeId', () => {
  it('accepts a valid 16-char hex string', () => {
    expect(sanitizeId('a1b2c3d4e5f6a7b8')).toBe('a1b2c3d4e5f6a7b8');
  });

  it('throws on SQL injection attempt', () => {
    expect(() => sanitizeId("' OR 1=1 --")).toThrow('Invalid function ID');
  });

  it('throws on empty string', () => {
    expect(() => sanitizeId('')).toThrow('Invalid function ID');
  });

  it('throws on uppercase hex', () => {
    expect(() => sanitizeId('A1B2C3D4E5F6A7B8')).toThrow('Invalid function ID');
  });

  it('throws on wrong length', () => {
    expect(() => sanitizeId('a1b2c3')).toThrow('Invalid function ID');
  });

  it('throws on special characters', () => {
    expect(() => sanitizeId('a1b2c3d4e5f6a7b!')).toThrow('Invalid function ID');
  });
});

describe('sanitizeFilePath', () => {
  it('returns normal paths unchanged', () => {
    expect(sanitizeFilePath('src/utils/cache.ts')).toBe('src/utils/cache.ts');
  });

  it('escapes single quotes', () => {
    expect(sanitizeFilePath("src/it's-a-file.ts")).toBe("src/it''s-a-file.ts");
  });

  it('escapes multiple single quotes', () => {
    expect(sanitizeFilePath("a'b'c")).toBe("a''b''c");
  });

  it('handles SQL injection attempt in file path', () => {
    expect(sanitizeFilePath("'; DROP TABLE cards; --")).toBe("''; DROP TABLE cards; --");
  });
});
