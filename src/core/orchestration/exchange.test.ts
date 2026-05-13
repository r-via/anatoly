// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  createExchange,
  ExchangeWriteError,
  ExchangeReadError,
  ExchangeSchemaMismatchError,
} from './exchange.js';

// ---------------------------------------------------------------------------
// Schemas used in tests
// ---------------------------------------------------------------------------

const UserSchema = z.object({
  name: z.string(),
  age: z.number(),
});

const ExtendedUserSchema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string(),
});

const PartialSchema = z.object({
  name: z.string(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createExchange', () => {
  // -------------------------------------------------------------------------
  // write with valid Zod passes
  // -------------------------------------------------------------------------

  describe('write with valid Zod', () => {
    it('should accept output matching the schema', () => {
      const exchange = createExchange();
      expect(() => {
        exchange.write('step1', { name: 'Alice', age: 30 }, UserSchema);
      }).not.toThrow();
    });

    it('should make the step available for reading after write', () => {
      const exchange = createExchange();
      exchange.write('step1', { name: 'Alice', age: 30 }, UserSchema);
      expect(exchange.has('step1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // write with invalid Zod throws ExchangeWriteError
  // -------------------------------------------------------------------------

  describe('write with invalid Zod', () => {
    it('should throw ExchangeWriteError when output does not match schema', () => {
      const exchange = createExchange();
      expect(() => {
        exchange.write('step1', { name: 'Alice', age: 'thirty' }, UserSchema);
      }).toThrow(ExchangeWriteError);
    });

    it('should include step ID in error message', () => {
      const exchange = createExchange();
      try {
        exchange.write('step1', { name: 123 }, UserSchema);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ExchangeWriteError);
        expect((err as ExchangeWriteError).message).toContain('step1');
      }
    });

    it('should include validation details in error message', () => {
      const exchange = createExchange();
      try {
        exchange.write('step1', { name: 123, age: 'bad' }, UserSchema);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ExchangeWriteError);
        expect((err as ExchangeWriteError).message).toContain('validation');
      }
    });

    it('should throw for completely missing fields', () => {
      const exchange = createExchange();
      expect(() => {
        exchange.write('step1', {}, UserSchema);
      }).toThrow(ExchangeWriteError);
    });
  });

  // -------------------------------------------------------------------------
  // read of missing step throws ExchangeReadError
  // -------------------------------------------------------------------------

  describe('read of missing step', () => {
    it('should throw ExchangeReadError when step has not been written', () => {
      const exchange = createExchange();
      expect(() => {
        exchange.read('nonexistent', UserSchema);
      }).toThrow(ExchangeReadError);
    });

    it('should include step ID in error message', () => {
      const exchange = createExchange();
      try {
        exchange.read('missing-step', UserSchema);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ExchangeReadError);
        expect((err as ExchangeReadError).message).toContain('missing-step');
      }
    });
  });

  // -------------------------------------------------------------------------
  // read with mismatched schema throws ExchangeSchemaMismatchError
  // -------------------------------------------------------------------------

  describe('read with mismatched schema', () => {
    it('should succeed when read schema accepts the stored value', () => {
      const exchange = createExchange();
      exchange.write(
        'step1',
        { name: 'Alice', age: 30 },
        UserSchema,
      );

      // PartialSchema only requires `name` — it accepts the value
      const result = exchange.read('step1', PartialSchema);
      expect(result).toEqual({ name: 'Alice' });
    });

    it('should throw ExchangeSchemaMismatchError when read schema rejects the value', () => {
      const exchange = createExchange();
      exchange.write('step1', { name: 'Alice', age: 30 }, UserSchema);

      // ExtendedUserSchema requires `email` which was not written
      expect(() => {
        exchange.read('step1', ExtendedUserSchema);
      }).toThrow(ExchangeSchemaMismatchError);
    });

    it('should include step ID and field path in error message', () => {
      const exchange = createExchange();
      exchange.write('step1', { name: 'Alice', age: 30 }, UserSchema);

      try {
        exchange.read('step1', ExtendedUserSchema);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ExchangeSchemaMismatchError);
        expect((err as ExchangeSchemaMismatchError).message).toContain('step1');
      }
    });
  });

  // -------------------------------------------------------------------------
  // read succeeds for compatible schemas
  // -------------------------------------------------------------------------

  describe('read with compatible schemas', () => {
    it('should return validated data matching the read schema', () => {
      const exchange = createExchange();
      exchange.write('step1', { name: 'Bob', age: 25 }, UserSchema);

      const result = exchange.read('step1', UserSchema);
      expect(result).toEqual({ name: 'Bob', age: 25 });
    });

    it('should work with z.any() as read schema', () => {
      const exchange = createExchange();
      exchange.write('step1', { name: 'Bob', age: 25 }, UserSchema);

      const result = exchange.read('step1', z.any());
      expect(result).toEqual({ name: 'Bob', age: 25 });
    });
  });

  // -------------------------------------------------------------------------
  // has() checks
  // -------------------------------------------------------------------------

  describe('has', () => {
    it('should return false for unwritten steps', () => {
      const exchange = createExchange();
      expect(exchange.has('step1')).toBe(false);
    });

    it('should return true for written steps', () => {
      const exchange = createExchange();
      exchange.write('step1', { name: 'Alice', age: 30 }, UserSchema);
      expect(exchange.has('step1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // snapshot returns deep copy
  // -------------------------------------------------------------------------

  describe('snapshot', () => {
    it('should return all written step outputs', () => {
      const exchange = createExchange();
      exchange.write('a', { name: 'A', age: 1 }, UserSchema);
      exchange.write('b', { name: 'B', age: 2 }, UserSchema);

      const snap = exchange.snapshot();
      expect(snap).toEqual({
        a: { name: 'A', age: 1 },
        b: { name: 'B', age: 2 },
      });
    });

    it('should return a deep copy (mutation does not affect snapshot)', () => {
      const exchange = createExchange();
      const data = { name: 'Alice', age: 30 };
      exchange.write('step1', data, UserSchema);

      const snap1 = exchange.snapshot();

      // Mutate the original data
      data.age = 99;

      // Snapshot should not be affected
      const snap2 = exchange.snapshot();
      expect(snap1).toEqual({ step1: { name: 'Alice', age: 30 } });
      expect(snap2).toEqual({ step1: { name: 'Alice', age: 30 } });
    });

    it('should not be affected by mutations to the returned snapshot object', () => {
      const exchange = createExchange();
      exchange.write('step1', { name: 'Alice', age: 30 }, UserSchema);

      const snap1 = exchange.snapshot();
      (snap1.step1 as { name: string }).name = 'MUTATED';

      const snap2 = exchange.snapshot();
      expect((snap2.step1 as { name: string }).name).toBe('Alice');
    });

    it('should return empty object when no steps written', () => {
      const exchange = createExchange();
      expect(exchange.snapshot()).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Multiple exchanges are isolated (no cross-contamination)
  // -------------------------------------------------------------------------

  describe('isolation', () => {
    it('should not share state between different exchanges', () => {
      const ex1 = createExchange();
      const ex2 = createExchange();

      ex1.write('step1', { name: 'Alice', age: 30 }, UserSchema);

      expect(ex1.has('step1')).toBe(true);
      expect(ex2.has('step1')).toBe(false);
    });

    it('should allow same step IDs in different exchanges without conflict', () => {
      const ex1 = createExchange();
      const ex2 = createExchange();

      ex1.write('step1', { name: 'Alice', age: 30 }, UserSchema);
      ex2.write('step1', { name: 'Bob', age: 25 }, UserSchema);

      expect(ex1.read('step1', UserSchema)).toEqual({ name: 'Alice', age: 30 });
      expect(ex2.read('step1', UserSchema)).toEqual({ name: 'Bob', age: 25 });
    });
  });

  // -------------------------------------------------------------------------
  // Error class hierarchy
  // -------------------------------------------------------------------------

  describe('error classes', () => {
    it('ExchangeWriteError should be an instance of Error', () => {
      const err = new ExchangeWriteError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ExchangeWriteError');
    });

    it('ExchangeReadError should be an instance of Error', () => {
      const err = new ExchangeReadError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ExchangeReadError');
    });

    it('ExchangeSchemaMismatchError should be an instance of Error', () => {
      const err = new ExchangeSchemaMismatchError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ExchangeSchemaMismatchError');
    });
  });
});
