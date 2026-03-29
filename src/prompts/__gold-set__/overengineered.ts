// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Gold-set fixture: overengineering axis — a LEAN function alongside an
 * absurdly OVER-engineered one that does the same thing with unnecessary
 * abstractions.
 */

// ---------------------------------------------------------------------------
// LEAN — simple, does one thing well
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// OVER — factory + strategy pattern + generics for a simple string formatter
// ---------------------------------------------------------------------------

interface FormatterStrategy<T> {
  validate(input: T): boolean;
  transform(input: T): string;
  postProcess(output: string): string;
}

interface FormatterConfig<T> {
  strategy: FormatterStrategy<T>;
  enableCaching: boolean;
  maxCacheSize: number;
  onError: (error: Error) => string;
}

class FormatterFactory<T> {
  private cache = new Map<string, string>();

  constructor(private readonly config: FormatterConfig<T>) {}

  format(input: T): string {
    const cacheKey = JSON.stringify(input);

    if (this.config.enableCaching && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    if (!this.config.strategy.validate(input)) {
      return this.config.onError(new Error('Validation failed'));
    }

    const raw = this.config.strategy.transform(input);
    const result = this.config.strategy.postProcess(raw);

    if (this.config.enableCaching) {
      if (this.cache.size >= this.config.maxCacheSize) {
        const firstKey = this.cache.keys().next().value!;
        this.cache.delete(firstKey);
      }
      this.cache.set(cacheKey, result);
    }

    return result;
  }
}

const slugStrategy: FormatterStrategy<string> = {
  validate: (input: string) => typeof input === 'string' && input.length > 0,
  transform: (input: string) => input.toLowerCase().trim(),
  postProcess: (output: string) =>
    output
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, ''),
};

export function slugifyOverengineered(text: string): string {
  const factory = new FormatterFactory<string>({
    strategy: slugStrategy,
    enableCaching: true,
    maxCacheSize: 100,
    onError: () => '',
  });
  return factory.format(text);
}
