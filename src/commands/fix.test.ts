import { describe, it, expect } from 'vitest';
import { parseUncheckedActions } from './fix.js';
import { makeActId } from '../core/reporter.js';

describe('parseUncheckedActions', () => {
  it('should parse a typical shard action line', () => {
    const actId = makeActId('src/foo.ts', 1);
    const content = `- [ ] <!-- ${actId} --> **[utility \u00B7 high \u00B7 trivial]** \`src/foo.ts\`: Remove dead export (\`fn\`) [1-5]`;
    const items = parseUncheckedActions(content);
    expect(items).toHaveLength(1);
    expect(items[0].actId).toBe(actId);
    expect(items[0].severity).toBe('high');
    expect(items[0].source).toBe('utility');
    expect(items[0].file).toBe('src/foo.ts');
    expect(items[0].description).toBe('Remove dead export');
    expect(items[0].symbol).toBe('fn');
  });

  it('should parse action without source axis', () => {
    const actId = makeActId('src/bar.ts', 2);
    const content = `- [ ] <!-- ${actId} --> **[medium \u00B7 small]** \`src/bar.ts\`: Add error handling`;
    const items = parseUncheckedActions(content);
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('');
    expect(items[0].severity).toBe('medium');
    expect(items[0].description).toBe('Add error handling');
  });

  it('should return empty for file without checkboxes', () => {
    const content = `# Shard 1\n\nSome text without any checkboxes.`;
    expect(parseUncheckedActions(content)).toEqual([]);
  });

  it('should skip already-checked actions', () => {
    const actId = makeActId('src/foo.ts', 1);
    const content = [
      `- [x] <!-- ${actId} --> **[high \u00B7 small]** \`src/foo.ts\`: Already done`,
      `- [ ] <!-- ${makeActId('src/bar.ts', 1)} --> **[medium \u00B7 small]** \`src/bar.ts\`: Still todo`,
    ].join('\n');
    const items = parseUncheckedActions(content);
    expect(items).toHaveLength(1);
    expect(items[0].file).toBe('src/bar.ts');
  });

  it('should parse multiple actions', () => {
    const content = [
      `- [ ] <!-- ${makeActId('a.ts', 1)} --> **[correction \u00B7 high \u00B7 small]** \`a.ts\`: Fix bug`,
      `- [ ] <!-- ${makeActId('b.ts', 1)} --> **[utility \u00B7 medium \u00B7 trivial]** \`b.ts\`: Remove dead code`,
      `- [ ] <!-- ${makeActId('c.ts', 1)} --> **[low \u00B7 small]** \`c.ts\`: Clean up`,
    ].join('\n');
    const items = parseUncheckedActions(content);
    expect(items).toHaveLength(3);
    expect(items[0].severity).toBe('high');
    expect(items[1].severity).toBe('medium');
    expect(items[2].severity).toBe('low');
  });

  it('should parse checklist-style line with emoji', () => {
    const actId = makeActId('src/foo.ts', 1);
    const content = `- [ ] <!-- ${actId} --> \u{1F534} **[correction \u00B7 high]** \`src/foo.ts\`: Fix null check (\`handleInput\`)`;
    const items = parseUncheckedActions(content);
    expect(items).toHaveLength(1);
    expect(items[0].actId).toBe(actId);
    expect(items[0].source).toBe('correction');
    expect(items[0].severity).toBe('high');
    expect(items[0].symbol).toBe('handleInput');
  });
});
