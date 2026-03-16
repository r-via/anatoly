import { describe, it, expect } from 'vitest';
import { checkAction, allActionsChecked, checkShardInIndex } from './clean-sync.js';
import { makeActId } from '../core/reporter.js';

describe('checkAction', () => {
  it('should check a matching unchecked action', () => {
    const actId = makeActId('src/foo.ts', 1);
    const content = `- [ ] <!-- ${actId} --> **[high]** Fix it`;
    const result = checkAction(content, actId);
    expect(result.changed).toBe(true);
    expect(result.content).toContain(`- [x] <!-- ${actId} -->`);
    expect(result.content).not.toContain('- [ ]');
  });

  it('should not change already-checked actions', () => {
    const actId = makeActId('src/foo.ts', 1);
    const content = `- [x] <!-- ${actId} --> **[high]** Fix it`;
    const result = checkAction(content, actId);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
  });

  it('should not change when actId not found', () => {
    const content = `- [ ] <!-- ACT-aaaaaa-1 --> **[high]** Fix it`;
    const result = checkAction(content, 'ACT-bbbbbb-2');
    expect(result.changed).toBe(false);
  });

  it('should check same actId in multiple locations', () => {
    const actId = makeActId('src/foo.ts', 1);
    const content = [
      `- [ ] <!-- ${actId} --> **[high]** In shard`,
      `Some other content`,
      `- [ ] <!-- ${actId} --> **[high]** In checklist`,
    ].join('\n');
    const result = checkAction(content, actId);
    expect(result.changed).toBe(true);
    expect(result.content).not.toContain('- [ ]');
  });

  it('should be idempotent', () => {
    const actId = makeActId('src/foo.ts', 1);
    const content = `- [ ] <!-- ${actId} --> **[high]** Fix it`;
    const r1 = checkAction(content, actId);
    const r2 = checkAction(r1.content, actId);
    expect(r2.changed).toBe(false);
    expect(r2.content).toBe(r1.content);
  });
});

describe('allActionsChecked', () => {
  it('should return true when no ACT checkboxes exist', () => {
    expect(allActionsChecked('No checkboxes here')).toBe(true);
  });

  it('should return true when all ACT checkboxes are checked', () => {
    const content = [
      `- [x] <!-- ACT-aaaaaa-1 --> done`,
      `- [x] <!-- ACT-bbbbbb-2 --> done`,
    ].join('\n');
    expect(allActionsChecked(content)).toBe(true);
  });

  it('should return false when any ACT checkbox is unchecked', () => {
    const content = [
      `- [x] <!-- ACT-aaaaaa-1 --> done`,
      `- [ ] <!-- ACT-bbbbbb-2 --> not done`,
    ].join('\n');
    expect(allActionsChecked(content)).toBe(false);
  });
});

describe('checkShardInIndex', () => {
  it('should check shard line when found', () => {
    const content = [
      '## Shards',
      '',
      '- [ ] [report.1.md](./report.1.md) (5 files)',
      '- [ ] [report.2.md](./report.2.md) (3 files)',
    ].join('\n');
    const result = checkShardInIndex(content, 'report.1.md');
    expect(result.changed).toBe(true);
    expect(result.content).toContain('- [x] [report.1.md]');
    expect(result.content).toContain('- [ ] [report.2.md]');
  });

  it('should not change when shard not found', () => {
    const content = '- [ ] [report.1.md](./report.1.md)';
    const result = checkShardInIndex(content, 'report.99.md');
    expect(result.changed).toBe(false);
  });

  it('should be idempotent', () => {
    const content = '- [x] [report.1.md](./report.1.md)';
    const result = checkShardInIndex(content, 'report.1.md');
    expect(result.changed).toBe(false);
  });
});

describe('fix-sync integration', () => {
  it('partial sync: 2/3 stories completed', () => {
    const act1 = makeActId('a.ts', 1);
    const act2 = makeActId('b.ts', 1);
    const act3 = makeActId('c.ts', 1);

    let shard = [
      `- [ ] <!-- ${act1} --> **[high]** Fix A`,
      `- [ ] <!-- ${act2} --> **[medium]** Fix B`,
      `- [ ] <!-- ${act3} --> **[low]** Fix C`,
    ].join('\n');

    // Sync act1 and act2
    const r1 = checkAction(shard, act1);
    const r2 = checkAction(r1.content, act2);
    shard = r2.content;

    expect(shard).toContain(`- [x] <!-- ${act1} -->`);
    expect(shard).toContain(`- [x] <!-- ${act2} -->`);
    expect(shard).toContain(`- [ ] <!-- ${act3} -->`);
    expect(allActionsChecked(shard)).toBe(false);
  });

  it('full sync: all stories completed, shard checked in index', () => {
    const act1 = makeActId('a.ts', 1);
    const act2 = makeActId('a.ts', 2);

    let shard = [
      `- [ ] <!-- ${act1} --> **[high]** Fix A`,
      `- [ ] <!-- ${act2} --> **[medium]** Fix B`,
    ].join('\n');

    let index = [
      '## Shards',
      '- [ ] [report.1.md](./report.1.md) (1 file)',
      '',
      '## Checklist',
      `- [ ] <!-- ${act1} --> Fix A`,
      `- [ ] <!-- ${act2} --> Fix B`,
    ].join('\n');

    // Sync both actions
    shard = checkAction(checkAction(shard, act1).content, act2).content;
    index = checkAction(checkAction(index, act1).content, act2).content;

    expect(allActionsChecked(shard)).toBe(true);

    // Check shard in index
    const indexResult = checkShardInIndex(index, 'report.1.md');
    expect(indexResult.changed).toBe(true);
    expect(indexResult.content).toContain('- [x] [report.1.md]');
  });
});
