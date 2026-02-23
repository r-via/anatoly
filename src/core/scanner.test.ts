import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, scanProject, loadCoverage } from './scanner.js';
import type { Config } from '../schemas/config.js';
import { ConfigSchema } from '../schemas/config.js';

describe('parseFile', () => {
  it('should extract exported function declarations', async () => {
    const source = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}`;
    const symbols = await parseFile('test.ts', source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      name: 'greet',
      kind: 'function',
      exported: true,
      line_start: 1,
    });
  });

  it('should extract non-exported functions', async () => {
    const source = `function helper() { return 42; }`;
    const symbols = await parseFile('test.ts', source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      name: 'helper',
      kind: 'function',
      exported: false,
    });
  });

  it('should extract class declarations', async () => {
    const source = `export class UserService {
  getName() { return 'test'; }
}`;
    const symbols = await parseFile('test.ts', source);
    expect(symbols.some((s) => s.name === 'UserService' && s.kind === 'class' && s.exported)).toBe(true);
  });

  it('should extract type aliases and interfaces', async () => {
    const source = `export type UserId = string;
export interface User {
  id: UserId;
  name: string;
}`;
    const symbols = await parseFile('test.ts', source);
    const types = symbols.filter((s) => s.kind === 'type');
    expect(types).toHaveLength(2);
    expect(types.map((t) => t.name).sort()).toEqual(['User', 'UserId']);
  });

  it('should extract enums', async () => {
    const source = `export enum Status { Active, Inactive }`;
    const symbols = await parseFile('test.ts', source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'Status', kind: 'enum', exported: true });
  });

  it('should detect hooks (useXxx pattern)', async () => {
    const source = `export function useAuth() { return null; }`;
    const symbols = await parseFile('test.ts', source);
    expect(symbols[0]).toMatchObject({ name: 'useAuth', kind: 'hook' });
  });

  it('should detect constants (UPPER_SNAKE_CASE)', async () => {
    const source = `export const MAX_RETRIES = 3;`;
    const symbols = await parseFile('test.ts', source);
    expect(symbols[0]).toMatchObject({ name: 'MAX_RETRIES', kind: 'constant' });
  });

  it('should detect arrow function variables', async () => {
    const source = `export const formatName = (name: string) => name.trim();`;
    const symbols = await parseFile('test.ts', source);
    expect(symbols[0]).toMatchObject({ name: 'formatName', kind: 'function' });
  });

  it('should handle mixed declarations', async () => {
    const source = `
export function doWork() {}
const helper = () => {};
export type Config = { key: string };
export const VERSION = '1.0';
let counter = 0;
`;
    const symbols = await parseFile('test.ts', source);
    expect(symbols.length).toBeGreaterThanOrEqual(4);
    expect(symbols.find((s) => s.name === 'doWork')?.exported).toBe(true);
    expect(symbols.find((s) => s.name === 'helper')?.exported).toBe(false);
    expect(symbols.find((s) => s.name === 'Config')?.kind).toBe('type');
  });
});

describe('scanProject', () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-scan-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    writeFileSync(
      join(tempDir, 'src', 'index.ts'),
      `export function main() { console.log('hello'); }\n`,
    );
    writeFileSync(
      join(tempDir, 'src', 'utils.ts'),
      `export const MAX_SIZE = 100;\nexport type ID = string;\n`,
    );

    config = ConfigSchema.parse({
      scan: {
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts'],
      },
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should scan files and generate .task.json and progress.json', async () => {
    const result = await scanProject(tempDir, config);
    expect(result.filesScanned).toBe(2);
    expect(result.filesNew).toBe(2);
    expect(result.filesCached).toBe(0);

    // Check task files
    const taskFile = readFileSync(
      join(tempDir, '.anatoly', 'tasks', 'src-index.task.json'),
      'utf-8',
    );
    const task = JSON.parse(taskFile);
    expect(task.version).toBe(1);
    expect(task.file).toBe('src/index.ts');
    expect(task.hash).toHaveLength(64);
    expect(task.symbols).toHaveLength(1);
    expect(task.symbols[0].name).toBe('main');

    // Check progress
    const progressFile = readFileSync(
      join(tempDir, '.anatoly', 'cache', 'progress.json'),
      'utf-8',
    );
    const progress = JSON.parse(progressFile);
    expect(progress.version).toBe(1);
    expect(progress.files['src/index.ts'].status).toBe('PENDING');
    expect(progress.files['src/utils.ts'].status).toBe('PENDING');
  });

  it('should cache unchanged files on re-scan', async () => {
    // First scan
    await scanProject(tempDir, config);

    // Simulate DONE status by modifying progress
    const progressPath = join(tempDir, '.anatoly', 'cache', 'progress.json');
    const progress = JSON.parse(readFileSync(progressPath, 'utf-8'));
    for (const key of Object.keys(progress.files)) {
      progress.files[key].status = 'DONE';
    }
    writeFileSync(progressPath, JSON.stringify(progress));

    // Re-scan (no changes)
    const result = await scanProject(tempDir, config);
    expect(result.filesCached).toBe(2);
    expect(result.filesNew).toBe(0);
  });

  it('should re-scan files that changed', async () => {
    // First scan
    await scanProject(tempDir, config);

    // Mark as DONE
    const progressPath = join(tempDir, '.anatoly', 'cache', 'progress.json');
    const progress = JSON.parse(readFileSync(progressPath, 'utf-8'));
    for (const key of Object.keys(progress.files)) {
      progress.files[key].status = 'DONE';
    }
    writeFileSync(progressPath, JSON.stringify(progress));

    // Modify one file
    writeFileSync(
      join(tempDir, 'src', 'index.ts'),
      `export function main() { console.log('changed!'); }\nexport const foo = 42;\n`,
    );

    // Re-scan
    const result = await scanProject(tempDir, config);
    expect(result.filesNew).toBe(1); // index.ts changed
    expect(result.filesCached).toBe(1); // utils.ts unchanged
  });
});

describe('loadCoverage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anatoly-cov-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<{ enabled: boolean; report_path: string }> = {}): Config {
    return ConfigSchema.parse({
      coverage: {
        enabled: overrides.enabled ?? true,
        report_path: overrides.report_path ?? 'coverage/coverage-final.json',
      },
    });
  }

  it('should return null when coverage is disabled', () => {
    const config = makeConfig({ enabled: false });
    const result = loadCoverage(tempDir, config);
    expect(result).toBeNull();
  });

  it('should return null when coverage file is missing', () => {
    const config = makeConfig();
    const result = loadCoverage(tempDir, config);
    expect(result).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    mkdirSync(join(tempDir, 'coverage'), { recursive: true });
    writeFileSync(join(tempDir, 'coverage', 'coverage-final.json'), 'not json');
    const config = makeConfig();
    const result = loadCoverage(tempDir, config);
    expect(result).toBeNull();
  });

  it('should parse Istanbul coverage format', () => {
    mkdirSync(join(tempDir, 'coverage'), { recursive: true });
    const istanbul = {
      'src/index.ts': {
        path: join(tempDir, 'src/index.ts'),
        statementMap: {
          '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 30 } },
          '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } },
        },
        s: { '0': 5, '1': 0 },
        fnMap: {
          '0': { name: 'main', decl: { start: { line: 1 }, end: { line: 1 } } },
        },
        f: { '0': 5 },
        branchMap: {
          '0': { type: 'if', locations: [{}, {}] },
        },
        b: { '0': [3, 2] },
      },
    };
    writeFileSync(
      join(tempDir, 'coverage', 'coverage-final.json'),
      JSON.stringify(istanbul),
    );

    const config = makeConfig();
    const result = loadCoverage(tempDir, config);
    expect(result).not.toBeNull();

    const cov = result!.get('src/index.ts');
    expect(cov).toBeDefined();
    expect(cov!.statements_total).toBe(2);
    expect(cov!.statements_covered).toBe(1);
    expect(cov!.functions_total).toBe(1);
    expect(cov!.functions_covered).toBe(1);
    expect(cov!.branches_total).toBe(2);
    expect(cov!.branches_covered).toBe(2); // both [3, 2] > 0
    expect(cov!.lines_total).toBe(2);
    expect(cov!.lines_covered).toBe(1);
  });

  it('should normalize absolute paths to relative', () => {
    mkdirSync(join(tempDir, 'coverage'), { recursive: true });
    const istanbul = {
      [join(tempDir, 'src/utils.ts')]: {
        path: join(tempDir, 'src/utils.ts'),
        statementMap: {
          '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        },
        s: { '0': 1 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    };
    writeFileSync(
      join(tempDir, 'coverage', 'coverage-final.json'),
      JSON.stringify(istanbul),
    );

    const config = makeConfig();
    const result = loadCoverage(tempDir, config);
    expect(result).not.toBeNull();
    expect(result!.has('src/utils.ts')).toBe(true);
  });

  it('should inject coverage into task.json during scan', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    mkdirSync(join(tempDir, 'coverage'), { recursive: true });

    writeFileSync(
      join(tempDir, 'src', 'index.ts'),
      `export function main() { return 1; }\n`,
    );

    const istanbul = {
      'src/index.ts': {
        path: 'src/index.ts',
        statementMap: {
          '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 36 } },
        },
        s: { '0': 10 },
        fnMap: { '0': { name: 'main' } },
        f: { '0': 10 },
        branchMap: {},
        b: {},
      },
    };
    writeFileSync(
      join(tempDir, 'coverage', 'coverage-final.json'),
      JSON.stringify(istanbul),
    );

    const config = ConfigSchema.parse({
      scan: { include: ['src/**/*.ts'], exclude: [] },
      coverage: { enabled: true, report_path: 'coverage/coverage-final.json' },
    });

    await scanProject(tempDir, config);

    const taskFile = readFileSync(
      join(tempDir, '.anatoly', 'tasks', 'src-index.task.json'),
      'utf-8',
    );
    const task = JSON.parse(taskFile);
    expect(task.coverage).toBeDefined();
    expect(task.coverage.statements_total).toBe(1);
    expect(task.coverage.statements_covered).toBe(1);
    expect(task.coverage.functions_total).toBe(1);
    expect(task.coverage.functions_covered).toBe(1);
  });

  it('should not include coverage when disabled', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    writeFileSync(
      join(tempDir, 'src', 'index.ts'),
      `export function main() { return 1; }\n`,
    );

    const config = ConfigSchema.parse({
      scan: { include: ['src/**/*.ts'], exclude: [] },
      coverage: { enabled: false },
    });

    await scanProject(tempDir, config);

    const taskFile = readFileSync(
      join(tempDir, '.anatoly', 'tasks', 'src-index.task.json'),
      'utf-8',
    );
    const task = JSON.parse(taskFile);
    expect(task.coverage).toBeUndefined();
  });
});
