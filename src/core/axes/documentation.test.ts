import { describe, it, expect } from 'vitest';
import { buildDocumentationSystemPrompt, buildDocumentationUserMessage } from './documentation.js';
import type { AxisContext } from '../axis-evaluator.js';
import type { Task } from '../../schemas/task.js';
import type { Config } from '../../schemas/config.js';
import { ConfigSchema } from '../../schemas/config.js';

const mockTask: Task = {
  version: 1,
  file: 'src/core/scanner.ts',
  hash: 'abc123',
  symbols: [
    { name: 'scanProject', kind: 'function', exported: true, line_start: 1, line_end: 30 },
    { name: 'parseFile', kind: 'function', exported: true, line_start: 32, line_end: 50 },
    { name: 'helperFn', kind: 'function', exported: false, line_start: 52, line_end: 60 },
  ],
  scanned_at: '2026-03-18T00:00:00Z',
};

const mockConfig: Config = ConfigSchema.parse({});

function createCtx(overrides: Partial<AxisContext> = {}): AxisContext {
  return {
    task: mockTask,
    fileContent: 'export function scanProject() {}\nexport function parseFile() {}\nfunction helperFn() {}\n',
    config: mockConfig,
    projectRoot: '/tmp/test',
    ...overrides,
  };
}

describe('buildDocumentationSystemPrompt', () => {
  it('should produce a focused prompt mentioning documentation evaluation', () => {
    const prompt = buildDocumentationSystemPrompt();
    expect(prompt).toContain('documentation');
    expect(prompt).toContain('DOCUMENTED');
    expect(prompt).toContain('PARTIAL');
    expect(prompt).toContain('UNDOCUMENTED');
  });

  it('should mention JSDoc evaluation', () => {
    const prompt = buildDocumentationSystemPrompt();
    expect(prompt).toContain('JSDoc');
  });

  it('should not mention other axes', () => {
    const prompt = buildDocumentationSystemPrompt();
    expect(prompt).not.toContain('overengineering');
    expect(prompt).not.toContain('duplication');
  });
});

describe('buildDocumentationUserMessage', () => {
  it('should include file content and symbols', () => {
    const msg = buildDocumentationUserMessage(createCtx());
    expect(msg).toContain('src/core/scanner.ts');
    expect(msg).toContain('scanProject');
    expect(msg).toContain('parseFile');
    expect(msg).toContain('helperFn');
  });

  it('should show export status for each symbol', () => {
    const msg = buildDocumentationUserMessage(createCtx());
    expect(msg).toContain('export function scanProject');
    expect(msg).toContain('function helperFn');
    // helperFn is not exported, should not have 'export' prefix
    expect(msg).not.toMatch(/export\s+function\s+helperFn/);
  });

  it('should show "evaluate JSDoc only" when no docsTree', () => {
    const msg = buildDocumentationUserMessage(createCtx({ docsTree: null }));
    expect(msg).toContain('evaluate JSDoc only');
    expect(msg).not.toContain('Relevant Documentation Pages');
  });

  it('should show "evaluate JSDoc only" when docsTree is undefined', () => {
    const msg = buildDocumentationUserMessage(createCtx({ docsTree: undefined }));
    expect(msg).toContain('evaluate JSDoc only');
  });

  it('should include docsTree when provided', () => {
    const msg = buildDocumentationUserMessage(createCtx({
      docsTree: 'docs/\n├── 01-Overview.md\n└── 02-Architecture.md',
    }));
    expect(msg).toContain('Documentation Directory');
    expect(msg).toContain('01-Overview.md');
    expect(msg).toContain('02-Architecture.md');
  });

  it('should include relevant docs content when provided', () => {
    const msg = buildDocumentationUserMessage(createCtx({
      docsTree: 'docs/\n└── scanner.md',
      relevantDocs: [
        { path: 'docs/scanner.md', content: '# Scanner Module\n\nScans TypeScript files.' },
      ],
    }));
    expect(msg).toContain('Relevant Documentation Pages');
    expect(msg).toContain('docs/scanner.md');
    expect(msg).toContain('Scanner Module');
  });

  it('should not show relevant docs section when docsTree present but no matching docs', () => {
    const msg = buildDocumentationUserMessage(createCtx({
      docsTree: 'docs/\n└── other.md',
      relevantDocs: [],
    }));
    expect(msg).toContain('Documentation Directory');
    expect(msg).not.toContain('Relevant Documentation Pages');
  });
});
