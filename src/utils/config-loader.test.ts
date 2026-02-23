import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config-loader.js';
import { AnatolyError } from './errors.js';

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return defaults when no config file exists', () => {
    const config = loadConfig(tempDir);
    expect(config.project.monorepo).toBe(false);
    expect(config.scan.include).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
    expect(config.scan.exclude).toContain('node_modules/**');
    expect(config.coverage.enabled).toBe(true);
    expect(config.llm.timeout_per_file).toBe(180);
    expect(config.llm.max_retries).toBe(3);
  });

  it('should parse a valid .anatoly.yml', () => {
    const yml = `
project:
  name: my-project
  monorepo: true
scan:
  include:
    - "packages/*/src/**/*.ts"
  exclude:
    - "node_modules/**"
llm:
  model: claude-opus-4-20250514
  timeout_per_file: 300
`;
    writeFileSync(join(tempDir, '.anatoly.yml'), yml);
    const config = loadConfig(tempDir);
    expect(config.project.name).toBe('my-project');
    expect(config.project.monorepo).toBe(true);
    expect(config.scan.include).toEqual(['packages/*/src/**/*.ts']);
    expect(config.llm.model).toBe('claude-opus-4-20250514');
    expect(config.llm.timeout_per_file).toBe(300);
    // coverage should still have defaults since not specified
    expect(config.coverage.enabled).toBe(true);
  });

  it('should accept a custom config path', () => {
    const customPath = join(tempDir, 'custom-config.yml');
    writeFileSync(customPath, 'project:\n  name: custom\n');
    const config = loadConfig(tempDir, customPath);
    expect(config.project.name).toBe('custom');
  });

  it('should return defaults for an empty YAML file', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), '');
    const config = loadConfig(tempDir);
    expect(config.project.monorepo).toBe(false);
    expect(config.llm.max_retries).toBe(3);
  });

  it('should throw CONFIG_INVALID for malformed YAML', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), '  bad:\n- yaml: [unclosed');
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
    try {
      loadConfig(tempDir);
    } catch (err) {
      expect(err).toBeInstanceOf(AnatolyError);
      expect((err as AnatolyError).code).toBe('CONFIG_INVALID');
      expect((err as AnatolyError).recoverable).toBe(false);
    }
  });

  it('should throw CONFIG_INVALID for invalid config values', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), 'llm:\n  timeout_per_file: 0\n');
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
    try {
      loadConfig(tempDir);
    } catch (err) {
      expect(err).toBeInstanceOf(AnatolyError);
      expect((err as AnatolyError).code).toBe('CONFIG_INVALID');
    }
  });

  it('should throw CONFIG_INVALID for non-object YAML content', () => {
    writeFileSync(join(tempDir, '.anatoly.yml'), '"just a string"');
    expect(() => loadConfig(tempDir)).toThrow(AnatolyError);
  });
});
