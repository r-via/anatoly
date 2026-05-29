// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import type { DocConflict, DocConflictsLock } from '../schemas/doc-conflict.js';
import { loadDocConflicts } from '../core/documentation/index.js';

// ---------------------------------------------------------------------------
// Mock @clack/prompts
// ---------------------------------------------------------------------------

const selectMock = vi.fn<(opts: unknown) => Promise<string | symbol>>();
const textMock = vi.fn<(opts: unknown) => Promise<string | symbol>>();
const confirmMock = vi.fn<(opts: unknown) => Promise<boolean | symbol>>();
const noteMock = vi.fn();
const introMock = vi.fn();
const outroMock = vi.fn();
const cancelMock = vi.fn();
const spinnerStartMock = vi.fn();
const spinnerStopMock = vi.fn();
const spinnerMock = vi.fn(() => ({ start: spinnerStartMock, stop: spinnerStopMock }));
const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), success: vi.fn(), message: vi.fn() };

vi.mock('@clack/prompts', () => ({
  select: (opts: unknown) => selectMock(opts),
  text: (opts: unknown) => textMock(opts),
  confirm: (opts: unknown) => confirmMock(opts),
  note: (...args: unknown[]) => noteMock(...args),
  intro: (...args: unknown[]) => introMock(...args),
  outro: (...args: unknown[]) => outroMock(...args),
  cancel: (...args: unknown[]) => cancelMock(...args),
  spinner: () => spinnerMock(),
  isCancel: (val: unknown) => typeof val === 'symbol',
  log: logMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<DocConflict>): DocConflict {
  return {
    id: 'conflict-abc123',
    detected_at: '2025-01-15T10:00:00.000Z',
    anchor: {
      file: 'src/core/foo.ts',
      symbol: 'computeBar',
      line_range: [10, 25] as [number, number],
      code_hash: 'sha256-abc',
    },
    reference_excerpt: {
      path: 'docs/architecture.md',
      line_range: [5, 10] as [number, number],
      text: 'computeBar must never return null',
    },
    code_summary: 'Returns undefined when input is empty',
    signals: {
      doc_last_touched: '2025-01-01T00:00:00.000Z',
      code_last_touched: '2025-01-14T00:00:00.000Z',
      test_covers_current_behavior: true,
      presumption: 'doc-stale' as const,
    },
    verdict: 'pending' as const,
    status: 'active' as const,
    ...overrides,
  };
}

function makeLock(entries: DocConflict[]): DocConflictsLock {
  return {
    version: 1 as const,
    generated_at: '2025-01-15T10:00:00.000Z',
    entries,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'arbitrate-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeLock(lock: DocConflictsLock): void {
  const dir = join(tmpDir, '.anatoly', 'state', 'internal-docs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'doc-conflicts.yaml'), yamlStringify(lock), 'utf-8');
}

// ---------------------------------------------------------------------------
// Import the module under test (after mocks)
// ---------------------------------------------------------------------------

const {
  filterPendingEntries,
  filterReviewableEntries,
  formatListTable,
  applyVerdict,
  runArbitrateWizard,
  runRefreshStandalone,
} = await import('./docs-arbitrate.js');

// ---------------------------------------------------------------------------
// Unit tests: pure logic helpers
// ---------------------------------------------------------------------------

describe('Story 55.6 — filterPendingEntries', () => {
  it('returns only entries with verdict=pending', () => {
    const entries = [
      makeEntry({ id: 'a', verdict: 'pending' }),
      makeEntry({ id: 'b', verdict: 'doc-wins' }),
      makeEntry({ id: 'c', verdict: 'pending' }),
    ];
    const result = filterPendingEntries(entries);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('returns empty array when no pending entries', () => {
    const entries = [makeEntry({ verdict: 'doc-wins' }), makeEntry({ verdict: 'skip' })];
    expect(filterPendingEntries(entries)).toEqual([]);
  });
});

describe('Story 55.6 — filterReviewableEntries', () => {
  it('returns entries with status=applied for --review mode', () => {
    const entries = [
      makeEntry({ id: 'a', status: 'applied', verdict: 'doc-wins' }),
      makeEntry({ id: 'b', status: 'active', verdict: 'pending' }),
      makeEntry({ id: 'c', status: 'applied', verdict: 'code-wins' }),
    ];
    const result = filterReviewableEntries(entries);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toEqual(['a', 'c']);
  });
});

describe('Story 55.6 — formatListTable', () => {
  it('returns formatted table with id, file, symbol, verdict, status', () => {
    const entries = [
      makeEntry({ id: 'conflict-abc123', verdict: 'pending', status: 'active' }),
      makeEntry({ id: 'conflict-def456', verdict: 'doc-wins', status: 'applied' }),
    ];
    const table = formatListTable(entries);
    expect(table).toContain('conflict-abc123');
    expect(table).toContain('conflict-def456');
    expect(table).toContain('src/core/foo.ts');
    expect(table).toContain('computeBar');
    expect(table).toContain('pending');
    expect(table).toContain('doc-wins');
    expect(table).toContain('active');
    expect(table).toContain('applied');
  });

  it('handles entries without symbol', () => {
    const entries = [makeEntry({ id: 'x', anchor: { file: 'a.ts', code_hash: 'h' } })];
    const table = formatListTable(entries);
    expect(table).toContain('a.ts');
    expect(table).toContain('—'); // dash for missing symbol
  });
});

describe('Story 55.6 — applyVerdict', () => {
  it('sets verdict, verdict_set_at, and optional note', () => {
    const entry = makeEntry({ verdict: 'pending' });
    applyVerdict(entry, 'doc-wins', 'Docs are correct');
    expect(entry.verdict).toBe('doc-wins');
    expect(entry.verdict_set_at).toBeDefined();
    expect(entry.verdict_note).toBe('Docs are correct');
  });

  it('sets verdict without note when note is undefined', () => {
    const entry = makeEntry({ verdict: 'pending' });
    applyVerdict(entry, 'code-wins');
    expect(entry.verdict).toBe('code-wins');
    expect(entry.verdict_note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: wizard flow with mocked clack
// ---------------------------------------------------------------------------

describe('Story 55.6 — runArbitrateWizard (no conflicts)', () => {
  it('AC: displays "No conflicts" when doc-conflicts.yaml is absent', async () => {
    const result = await runArbitrateWizard(tmpDir, {});
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('No conflicts to arbitrate');
  });

  it('AC: displays "No conflicts" when file is empty (no entries)', async () => {
    writeLock(makeLock([]));
    const result = await runArbitrateWizard(tmpDir, {});
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('No conflicts to arbitrate');
  });
});

describe('Story 55.6 — runArbitrateWizard (--list)', () => {
  it('AC: displays table without wizard', async () => {
    writeLock(makeLock([
      makeEntry({ id: 'c1', verdict: 'pending', status: 'active' }),
      makeEntry({ id: 'c2', verdict: 'doc-wins', status: 'applied' }),
    ]));
    const result = await runArbitrateWizard(tmpDir, { list: true });
    expect(result.exitCode).toBe(0);
    expect(result.table).toContain('c1');
    expect(result.table).toContain('c2');
    // Should NOT have called any interactive prompts
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('Story 55.6 — runArbitrateWizard (interactive)', () => {
  it('AC: iterates pending entries, saves verdicts incrementally', async () => {
    const lock = makeLock([
      makeEntry({ id: 'c1', verdict: 'pending' }),
      makeEntry({ id: 'c2', verdict: 'pending' }),
      makeEntry({ id: 'c3', verdict: 'pending' }),
    ]);
    writeLock(lock);

    // Simulate user: doc-wins, code-wins, skip — with optional notes
    let selectCallNum = 0;
    selectMock.mockImplementation(async () => {
      selectCallNum++;
      if (selectCallNum === 1) return 'doc-wins';
      if (selectCallNum === 2) return 'code-wins';
      return 'skip';
    });
    textMock.mockImplementation(async () => 'Test note');

    const result = await runArbitrateWizard(tmpDir, {});
    expect(result.exitCode).toBe(0);

    // Verify the YAML was saved with verdicts applied
    const saved = loadDocConflicts(tmpDir);
    expect(saved).not.toBeNull();
    const entries = saved!.entries;
    expect(entries[0].verdict).toBe('doc-wins');
    expect(entries[1].verdict).toBe('code-wins');
    expect(entries[2].verdict).toBe('skip');
    // Notes should be set on doc-wins and code-wins
    expect(entries[0].verdict_note).toBe('Test note');
    expect(entries[1].verdict_note).toBe('Test note');
  });

  it('AC: Ctrl+C preserves already-rendered verdicts', async () => {
    const lock = makeLock([
      makeEntry({ id: 'c1', verdict: 'pending' }),
      makeEntry({ id: 'c2', verdict: 'pending' }),
    ]);
    writeLock(lock);

    let callNum = 0;
    selectMock.mockImplementation(async () => {
      callNum++;
      if (callNum === 1) return 'doc-wins';
      return Symbol.for('cancel'); // Ctrl+C on second entry
    });
    textMock.mockImplementation(async () => '');

    const result = await runArbitrateWizard(tmpDir, {});
    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(true);

    // First entry should be saved, second should remain pending
    const saved = loadDocConflicts(tmpDir);
    expect(saved).not.toBeNull();
    expect(saved!.entries[0].verdict).toBe('doc-wins');
    expect(saved!.entries[1].verdict).toBe('pending');
  });
});

describe('Story 55.6 — runArbitrateWizard (--review)', () => {
  it('AC: iterates applied entries and allows re-setting to pending', async () => {
    const lock = makeLock([
      makeEntry({ id: 'c1', verdict: 'doc-wins', status: 'applied' }),
      makeEntry({ id: 'c2', verdict: 'pending', status: 'active' }),
    ]);
    writeLock(lock);

    // In review mode, user chooses to re-open c1
    selectMock.mockImplementation(async () => 'pending');
    textMock.mockImplementation(async () => '');

    const result = await runArbitrateWizard(tmpDir, { review: true });
    expect(result.exitCode).toBe(0);

    const saved = loadDocConflicts(tmpDir);
    expect(saved).not.toBeNull();
    // c1 should be back to pending
    expect(saved!.entries[0].verdict).toBe('pending');
    expect(saved!.entries[0].status).toBe('active');
  });
});

describe('Story 55.6 — runArbitrateWizard (malformed YAML)', () => {
  it('AC: exits with non-zero exit code on malformed YAML', async () => {
    const dir = join(tmpDir, '.anatoly', 'state', 'internal-docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'doc-conflicts.yaml'), '{{invalid yaml', 'utf-8');

    const result = await runArbitrateWizard(tmpDir, {});
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
  });
});

describe('Story 55.6 — runArbitrateWizard (defer choice)', () => {
  it('AC: defer skips the entry without changing verdict', async () => {
    const lock = makeLock([
      makeEntry({ id: 'c1', verdict: 'pending' }),
    ]);
    writeLock(lock);

    selectMock.mockImplementation(async () => 'defer');

    const result = await runArbitrateWizard(tmpDir, {});
    expect(result.exitCode).toBe(0);

    const saved = loadDocConflicts(tmpDir);
    expect(saved).not.toBeNull();
    // Deferred entry remains pending
    expect(saved!.entries[0].verdict).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Refresh wire-up (PR 3)
// ---------------------------------------------------------------------------

describe('arbitrate refresh — wizard pre-step', () => {
  it('prompts for refresh, runs it on accept, then continues into the wizard', async () => {
    writeLock(makeLock([
      makeEntry({ id: 'c1', verdict: 'pending' }),
      makeEntry({ id: 'c2', verdict: 'pending' }),
    ]));

    confirmMock.mockResolvedValue(true);
    selectMock.mockResolvedValue('defer');

    const refreshFn = vi.fn(async (entries: DocConflict[]) => ({
      entries: entries.map((e) => e.id === 'c1'
        ? { ...e, verdict: 'dismiss' as const, status: 'auto-resolved' as const }
        : e),
      summary: {
        inspected: 2,
        autoResolved: { dismiss: 1, docWins: 0, codeWins: 0 },
        stillPending: 1,
        belowConfidence: 0,
        errors: 0,
      },
    }));

    const result = await runArbitrateWizard(tmpDir, { refreshFn });
    expect(result.exitCode).toBe(0);
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(result.refreshSummary?.autoResolved.dismiss).toBe(1);

    // Lock on disk should reflect the auto-resolution.
    const saved = loadDocConflicts(tmpDir);
    expect(saved!.entries[0].verdict).toBe('dismiss');
    expect(saved!.entries[0].status).toBe('auto-resolved');
    expect(saved!.entries[1].verdict).toBe('pending');
  });

  it('skips refresh when the user declines', async () => {
    writeLock(makeLock([makeEntry({ id: 'c1', verdict: 'pending' })]));
    confirmMock.mockResolvedValue(false);
    selectMock.mockResolvedValue('defer');

    const refreshFn = vi.fn();
    const result = await runArbitrateWizard(tmpDir, { refreshFn });
    expect(result.exitCode).toBe(0);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('cancels wizard when user cancels the refresh prompt', async () => {
    writeLock(makeLock([makeEntry({ id: 'c1', verdict: 'pending' })]));
    confirmMock.mockResolvedValue(Symbol.for('cancel'));

    const refreshFn = vi.fn();
    const result = await runArbitrateWizard(tmpDir, { refreshFn });
    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('does not prompt when skipRefreshPrompt is set', async () => {
    writeLock(makeLock([makeEntry({ id: 'c1', verdict: 'pending' })]));
    selectMock.mockResolvedValue('defer');

    const refreshFn = vi.fn();
    await runArbitrateWizard(tmpDir, { refreshFn, skipRefreshPrompt: true });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('does not prompt in --review mode', async () => {
    writeLock(makeLock([
      makeEntry({ id: 'c1', verdict: 'doc-wins', status: 'applied' }),
    ]));
    selectMock.mockResolvedValue('keep');

    const refreshFn = vi.fn();
    await runArbitrateWizard(tmpDir, { review: true, refreshFn });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('continues into the wizard if refreshFn throws', async () => {
    writeLock(makeLock([makeEntry({ id: 'c1', verdict: 'pending' })]));
    confirmMock.mockResolvedValue(true);
    selectMock.mockResolvedValue('defer');

    const refreshFn = vi.fn(async () => { throw new Error('LLM down'); });
    const result = await runArbitrateWizard(tmpDir, { refreshFn });
    expect(result.exitCode).toBe(0);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });
});

describe('runRefreshStandalone', () => {
  it('saves the refreshed ledger and reports the summary', async () => {
    writeLock(makeLock([
      makeEntry({ id: 'c1', verdict: 'pending' }),
      makeEntry({ id: 'c2', verdict: 'pending' }),
    ]));

    const refreshFn = vi.fn(async (entries: DocConflict[]) => ({
      entries: entries.map((e) => e.id === 'c1'
        ? { ...e, verdict: 'dismiss' as const, status: 'auto-resolved' as const }
        : e),
      summary: {
        inspected: 2,
        autoResolved: { dismiss: 1, docWins: 0, codeWins: 0 },
        stillPending: 1,
        belowConfidence: 0,
        errors: 0,
      },
    }));

    const result = await runRefreshStandalone(tmpDir, { refreshFn });
    expect(result.exitCode).toBe(0);
    expect(result.summary?.autoResolved.dismiss).toBe(1);
    expect(result.message).toContain('auto-resolved 1');

    const saved = loadDocConflicts(tmpDir);
    expect(saved!.entries[0].verdict).toBe('dismiss');
    expect(saved!.entries[0].status).toBe('auto-resolved');
  });

  it('honours --dry-run by skipping the write', async () => {
    writeLock(makeLock([makeEntry({ id: 'c1', verdict: 'pending' })]));

    const refreshFn = vi.fn(async (entries: DocConflict[]) => ({
      entries: entries.map((e) => ({ ...e, verdict: 'dismiss' as const, status: 'auto-resolved' as const })),
      summary: {
        inspected: 1,
        autoResolved: { dismiss: 1, docWins: 0, codeWins: 0 },
        stillPending: 0,
        belowConfidence: 0,
        errors: 0,
      },
    }));

    const result = await runRefreshStandalone(tmpDir, { refreshFn, dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('dry-run');

    const saved = loadDocConflicts(tmpDir);
    expect(saved!.entries[0].verdict).toBe('pending');
  });

  it('returns early with a message when no pending entries exist', async () => {
    writeLock(makeLock([makeEntry({ id: 'c1', verdict: 'doc-wins', status: 'applied' })]));

    const refreshFn = vi.fn();
    const result = await runRefreshStandalone(tmpDir, { refreshFn });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('No pending');
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('returns early when the ledger file is absent', async () => {
    const refreshFn = vi.fn();
    const result = await runRefreshStandalone(tmpDir, { refreshFn });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('No conflicts');
    expect(refreshFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Structural: command wired into docs group
// ---------------------------------------------------------------------------

describe('Story 55.6 — structural: arbitrate wired into docs', () => {
  it('docs.ts registers an arbitrate subcommand', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'commands', 'docs.ts'), 'utf-8');
    expect(src).toContain('arbitrate');
    expect(src).toContain('runArbitrateWizard');
  });
});

// Need readFileSync for the structural test
import { readFileSync } from 'node:fs';
