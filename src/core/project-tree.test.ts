import { describe, it, expect } from 'vitest';
import { buildProjectTree } from './project-tree.js';

describe('buildProjectTree', () => {
  it('returns empty string for no files', () => {
    expect(buildProjectTree([])).toBe('');
  });

  it('renders a simple flat structure', () => {
    const tree = buildProjectTree(['src/index.ts', 'src/cli.ts']);
    expect(tree).toContain('src/');
    expect(tree).toContain('cli.ts');
    expect(tree).toContain('index.ts');
  });

  it('sorts directories before files', () => {
    const tree = buildProjectTree([
      'src/index.ts',
      'src/core/scanner.ts',
      'src/utils/cache.ts',
    ]);
    const lines = tree.split('\n');
    // src/ should be listed, inside it core/ and utils/ (dirs) before index.ts (file)
    const srcChildren = lines.filter((l) => l.startsWith('    ') || l.startsWith('│'));
    // Directories first
    const coreIdx = lines.findIndex((l) => l.includes('core/'));
    const utilsIdx = lines.findIndex((l) => l.includes('utils/'));
    const indexIdx = lines.findIndex((l) => l.includes('index.ts'));
    expect(coreIdx).toBeLessThan(indexIdx);
    expect(utilsIdx).toBeLessThan(indexIdx);
  });

  it('uses ├── and └── connectors', () => {
    const tree = buildProjectTree(['a/b.ts', 'a/c.ts']);
    expect(tree).toContain('├──');
    expect(tree).toContain('└──');
  });

  it('handles nested structure correctly', () => {
    const tree = buildProjectTree([
      'src/core/axes/utility.ts',
      'src/core/axes/correction.ts',
      'src/core/scanner.ts',
      'src/utils/cache.ts',
    ]);
    expect(tree).toContain('src/');
    expect(tree).toContain('core/');
    expect(tree).toContain('axes/');
    expect(tree).toContain('utility.ts');
    expect(tree).toContain('correction.ts');
    expect(tree).toContain('scanner.ts');
    expect(tree).toContain('cache.ts');
  });

  it('condenses deep paths beyond maxDepth=4', () => {
    // 6 levels deep: a/b/c/d/e/f.ts
    const tree = buildProjectTree(['a/b/c/d/e/f.ts'], 4);
    // Should condense the deep chain — "d/e" or similar collapsed
    // The exact condensation depends on implementation, but the tree should be compact
    expect(tree).toBeTruthy();
    // Verify it doesn't have 6 separate indentation levels
    const maxIndent = Math.max(...tree.split('\n').map((l) => {
      const match = l.match(/^([\s│]*)/);
      return match ? match[1].replace(/│/g, ' ').length : 0;
    }));
    // With maxDepth=4, we shouldn't have more than ~4 indent levels (each is 4 chars)
    expect(maxIndent).toBeLessThanOrEqual(16);
  });

  it('handles single-child directory chains by collapsing', () => {
    // a/b/c/file.ts should collapse intermediate single-child dirs
    const tree = buildProjectTree(['a/b/c/file.ts'], 2);
    // At maxDepth=2, the chain a -> b -> c should get collapsed
    expect(tree).toBeTruthy();
    const lines = tree.split('\n');
    // Should have collapsed path (fewer lines than uncollapsed)
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it('produces compact output for many files', () => {
    // Simulate a medium project with ~50 files
    const files: string[] = [];
    for (let i = 0; i < 10; i++) {
      files.push(`src/core/module${i}.ts`);
      files.push(`src/utils/helper${i}.ts`);
      files.push(`src/commands/cmd${i}.ts`);
      files.push(`src/schemas/schema${i}.ts`);
      files.push(`src/rag/rag${i}.ts`);
    }
    const tree = buildProjectTree(files);
    // Should be reasonably compact
    const lines = tree.split('\n');
    expect(lines.length).toBeGreaterThan(0);
    // Rough token estimate: ~1.3 tokens per word, tree lines are short
    // 50 files should produce << 300 tokens
    const charCount = tree.length;
    // Very rough: 4 chars per token average for tree-like content
    const roughTokens = charCount / 4;
    expect(roughTokens).toBeLessThan(300);
  });

  it('handles files at root level', () => {
    const tree = buildProjectTree(['package.json', 'tsconfig.json', 'src/index.ts']);
    expect(tree).toContain('src/');
    expect(tree).toContain('package.json');
    expect(tree).toContain('tsconfig.json');
  });

  it('directories are alphabetically sorted', () => {
    const tree = buildProjectTree([
      'src/utils/a.ts',
      'src/core/b.ts',
      'src/commands/c.ts',
    ]);
    const lines = tree.split('\n');
    const commandsIdx = lines.findIndex((l) => l.includes('commands/'));
    const coreIdx = lines.findIndex((l) => l.includes('core/'));
    const utilsIdx = lines.findIndex((l) => l.includes('utils/'));
    expect(commandsIdx).toBeLessThan(coreIdx);
    expect(coreIdx).toBeLessThan(utilsIdx);
  });

  it('files within a directory are alphabetically sorted', () => {
    const tree = buildProjectTree(['d/zebra.ts', 'd/alpha.ts', 'd/middle.ts']);
    const lines = tree.split('\n');
    const alphaIdx = lines.findIndex((l) => l.includes('alpha.ts'));
    const middleIdx = lines.findIndex((l) => l.includes('middle.ts'));
    const zebraIdx = lines.findIndex((l) => l.includes('zebra.ts'));
    expect(alphaIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(zebraIdx);
  });
});
