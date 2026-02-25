import { describe, it, expect } from 'vitest';
import { ConfigSchema, AxisConfigSchema } from './config.js';

describe('ConfigSchema', () => {
  it('should apply all defaults when given empty object', () => {
    const config = ConfigSchema.parse({});
    expect(config.project.monorepo).toBe(false);
    expect(config.scan.include).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
    expect(config.scan.exclude).toContain('node_modules/**');
    expect(config.coverage.enabled).toBe(true);
    expect(config.llm.timeout_per_file).toBe(600);
    expect(config.llm.max_retries).toBe(3);
  });

  it('should accept a fully specified config', () => {
    const input = {
      project: { name: 'my-project', monorepo: true },
      scan: {
        include: ['packages/*/src/**/*.ts'],
        exclude: ['node_modules/**'],
      },
      coverage: {
        enabled: false,
        command: 'npx jest --coverage',
        report_path: 'coverage/lcov.json',
      },
      llm: {
        model: 'claude-opus-4-20250514',
        agentic_tools: true,
        timeout_per_file: 300,
        max_retries: 5,
      },
    };
    const result = ConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project.name).toBe('my-project');
      expect(result.data.llm.timeout_per_file).toBe(300);
    }
  });

  it('should reject invalid timeout_per_file', () => {
    const result = ConfigSchema.safeParse({
      llm: { timeout_per_file: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('should default min_confidence to 70', () => {
    const config = ConfigSchema.parse({});
    expect(config.llm.min_confidence).toBe(70);
  });

  it('should accept custom min_confidence', () => {
    const config = ConfigSchema.parse({
      llm: { min_confidence: 80 },
    });
    expect(config.llm.min_confidence).toBe(80);
  });

  it('should reject min_confidence below 0', () => {
    const result = ConfigSchema.safeParse({
      llm: { min_confidence: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject min_confidence above 100', () => {
    const result = ConfigSchema.safeParse({
      llm: { min_confidence: 101 },
    });
    expect(result.success).toBe(false);
  });
});

describe('AxisConfigSchema', () => {
  it('should default all axes to enabled', () => {
    const config = ConfigSchema.parse({});
    expect(config.llm.axes.utility.enabled).toBe(true);
    expect(config.llm.axes.duplication.enabled).toBe(true);
    expect(config.llm.axes.correction.enabled).toBe(true);
    expect(config.llm.axes.overengineering.enabled).toBe(true);
    expect(config.llm.axes.tests.enabled).toBe(true);
    expect(config.llm.axes.best_practices.enabled).toBe(true);
  });

  it('should accept per-axis model override', () => {
    const config = ConfigSchema.parse({
      llm: {
        axes: {
          correction: { model: 'claude-opus-4-20250514' },
        },
      },
    });
    expect(config.llm.axes.correction.model).toBe('claude-opus-4-20250514');
    expect(config.llm.axes.utility.model).toBeUndefined();
  });

  it('should accept disabling an axis', () => {
    const config = ConfigSchema.parse({
      llm: {
        axes: {
          best_practices: { enabled: false },
        },
      },
    });
    expect(config.llm.axes.best_practices.enabled).toBe(false);
    expect(config.llm.axes.utility.enabled).toBe(true);
  });

  it('should validate standalone AxisConfigSchema', () => {
    expect(AxisConfigSchema.safeParse({}).success).toBe(true);
    expect(AxisConfigSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(AxisConfigSchema.safeParse({ enabled: true, model: 'claude-haiku-4-5-20251001' }).success).toBe(true);
  });
});
