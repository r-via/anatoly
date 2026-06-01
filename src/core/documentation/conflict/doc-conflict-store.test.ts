// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import {
  loadDocConflicts,
  saveDocConflicts,
  hashCodeAnchor,
  verifyAnchorHash,
} from './doc-conflict-store.js';
import * as logger from '../../../utils/logger.js';
import type { DocConflictsLock, DocConflict } from '../../../schemas/doc-conflict.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'doc-conflict-store-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeValidLock(entries: DocConflict[] = []): DocConflictsLock {
  return {
    version: 1,
    generated_at: '2025-06-01T12:00:00Z',
    entries,
  };
}

function makeEntry(overrides: Partial<DocConflict> = {}): DocConflict {
  return {
    id: 'test-id-1',
    detected_at: '2025-06-01T00:00:00Z',
    anchor: {
      file: 'src/foo.ts',
      symbol: 'doThing',
      line_range: [10, 20],
      code_hash: 'a'.repeat(64),
    },
    reference_excerpt: {
      path: 'docs/api.md',
      text: 'doThing accepts a string.',
    },
    code_summary: 'doThing accepts a number.',
    signals: {
      doc_last_touched: '2025-05-01T00:00:00Z',
      code_last_touched: '2025-06-01T00:00:00Z',
      presumption: 'doc-stale',
    },
    verdict: 'pending',
    status: 'active',
    ...overrides,
  };
}

// doc 16 PR 1: canonical durable location (`.anatoly/state/` root).
function docConflictsDir(root: string): string {
  return join(root, '.anatoly', 'state');
}

function docConflictsPath(root: string): string {
  return join(docConflictsDir(root), 'doc-conflicts.yaml');
}

// Pre-doc-16 location, co-located with the regenerated scaffold fragments.
function legacyDocConflictsDir(root: string): string {
  return join(root, '.anatoly', 'state', 'internal-docs');
}

function legacyDocConflictsPath(root: string): string {
  return join(legacyDocConflictsDir(root), 'doc-conflicts.yaml');
}

// ---------------------------------------------------------------------------
// Story 55.3 — loadDocConflicts
// ---------------------------------------------------------------------------

describe('Story 55.3 — loadDocConflicts', () => {
  it('returns null when file does not exist', () => {
    const result = loadDocConflicts(tmpDir);
    expect(result).toBeNull();
  });

  it('loads a valid YAML lock file and returns parsed data', () => {
    const dir = docConflictsDir(tmpDir);
    mkdirSync(dir, { recursive: true });
    const lock = makeValidLock([makeEntry()]);
    writeFileSync(docConflictsPath(tmpDir), yamlStringify(lock));

    const result = loadDocConflicts(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].id).toBe('test-id-1');
  });

  it('throws on version: 2 with actionable message (NFR7)', () => {
    const dir = docConflictsDir(tmpDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(docConflictsPath(tmpDir), 'version: 2\ngenerated_at: "2025-01-01T00:00:00Z"\nentries: []\n');

    expect(() => loadDocConflicts(tmpDir)).toThrow(/unsupported version/i);
  });

  it('throws on malformed YAML', () => {
    const dir = docConflictsDir(tmpDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(docConflictsPath(tmpDir), 'version: 1\ngenerated_at: "x"\nentries:\n  - bad: true\n');

    expect(() => loadDocConflicts(tmpDir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Story 55.3 — saveDocConflicts
// ---------------------------------------------------------------------------

describe('Story 55.3 — saveDocConflicts', () => {
  it('writes a valid YAML file atomically', () => {
    const lock = makeValidLock([makeEntry()]);
    saveDocConflicts(tmpDir, lock);

    const path = docConflictsPath(tmpDir);
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('version: 1');
    expect(content).toContain('test-id-1');
  });

  it('round-trip: save → load preserves all fields', () => {
    const entry = makeEntry({
      verdict: 'doc-wins',
      verdict_set_at: '2025-06-02T10:00:00Z',
      verdict_note: 'Documentation is the source of truth here.',
      status: 'applied',
    });
    const lock = makeValidLock([entry]);

    saveDocConflicts(tmpDir, lock);
    const loaded = loadDocConflicts(tmpDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0]).toEqual(entry);
  });

  it('creates parent directories if they do not exist', () => {
    const lock = makeValidLock();
    saveDocConflicts(tmpDir, lock);

    expect(existsSync(docConflictsDir(tmpDir))).toBe(true);
  });

  it('overwrites existing file', () => {
    saveDocConflicts(tmpDir, makeValidLock([makeEntry()]));
    saveDocConflicts(tmpDir, makeValidLock([]));

    const loaded = loadDocConflicts(tmpDir);
    expect(loaded!.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Story 55.3 — hashCodeAnchor
// ---------------------------------------------------------------------------

describe('Story 55.3 — hashCodeAnchor', () => {
  it('returns a SHA-256 hex string', () => {
    const hash = hashCodeAnchor(undefined, 'function foo() { return 42; }');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes the full file content when no symbol or lineRange provided', () => {
    const content = 'function foo() { return 42; }\n';
    const h1 = hashCodeAnchor(undefined, content);
    const h2 = hashCodeAnchor(undefined, content);
    expect(h1).toBe(h2);
  });

  it('hashes the line range when provided', () => {
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const content = lines.join('\n');
    const hash = hashCodeAnchor([2, 4], content);
    // Should hash lines 2-4 only
    const hash2 = hashCodeAnchor([2, 4], content);
    expect(hash).toBe(hash2);
  });

  it('is stable across CRLF vs LF (NFR2 normalisation)', () => {
    const contentLf = 'function foo() {\n  return 42;\n}';
    const contentCrlf = 'function foo() {\r\n  return 42;\r\n}';
    const h1 = hashCodeAnchor(undefined, contentLf);
    const h2 = hashCodeAnchor(undefined, contentCrlf);
    expect(h1).toBe(h2);
  });

  it('is stable across leading/trailing whitespace (NFR2)', () => {
    const content1 = '  function foo() { return 42; }  ';
    const content2 = 'function foo() { return 42; }';
    const h1 = hashCodeAnchor(undefined, content1);
    const h2 = hashCodeAnchor(undefined, content2);
    expect(h1).toBe(h2);
  });

  it('different content produces different hash', () => {
    const h1 = hashCodeAnchor(undefined, 'function a() {}');
    const h2 = hashCodeAnchor(undefined, 'function b() {}');
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Line-range clamp logging — warn only when the clamp can mis-anchor
// ---------------------------------------------------------------------------

describe('hashCodeAnchor — clamp log level', () => {
  let warn: ReturnType<typeof vi.fn>;
  let debug: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    warn = vi.fn();
    debug = vi.fn();
    vi.spyOn(logger, 'getLogger').mockReturnValue(
      { warn, debug, info: vi.fn(), error: vi.fn() } as unknown as ReturnType<typeof logger.getLogger>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tenLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');

  it('does not log when the range is fully in bounds', () => {
    hashCodeAnchor([2, 5], tenLines);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs debug (not warn) when only the end overshoots EOF with a valid start', () => {
    // Mirrors the real run: src/core/transports/index.ts [183, 416] on a
    // 414-line file. Start in range, end a few lines past EOF → benign.
    hashCodeAnchor([3, 14], tenLines);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('still anchors to the real file tail on a benign end-overshoot', () => {
    // [3, 14] clamps to [3, 10] → identical hash to the explicit tail range.
    expect(hashCodeAnchor([3, 14], tenLines)).toBe(hashCodeAnchor([3, 10], tenLines));
  });

  it('warns when the start is clamped up from below 1', () => {
    hashCodeAnchor([0, 4], tenLines);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });

  it('warns when the start sits at/past EOF (fragment collapses to a stray line)', () => {
    hashCodeAnchor([10, 20], tenLines);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Story 55.3 — verifyAnchorHash
// ---------------------------------------------------------------------------

describe('Story 55.3 — verifyAnchorHash', () => {
  it('returns "valid" when code_hash matches current content', () => {
    const content = 'function doThing() { return 1; }';
    const codeHash = hashCodeAnchor(undefined, content);
    const entry = makeEntry({
      anchor: { file: 'src/foo.ts', code_hash: codeHash },
    });

    expect(verifyAnchorHash(entry, content)).toBe('valid');
  });

  it('returns "stale" when code_hash does not match current content', () => {
    const entry = makeEntry({
      anchor: { file: 'src/foo.ts', code_hash: 'x'.repeat(64) },
    });

    expect(verifyAnchorHash(entry, 'completely different code')).toBe('stale');
  });

  it('uses line_range from anchor when available', () => {
    const lines = ['line1', 'target line 2', 'target line 3', 'line4'];
    const content = lines.join('\n');
    const codeHash = hashCodeAnchor([2, 3], content);
    const entry = makeEntry({
      anchor: { file: 'src/foo.ts', line_range: [2, 3], code_hash: codeHash },
    });

    expect(verifyAnchorHash(entry, content)).toBe('valid');
  });

  it('returns "stale" when line range content changed', () => {
    const originalContent = 'line1\noriginal line 2\nline3';
    const codeHash = hashCodeAnchor([2, 2], originalContent);
    const entry = makeEntry({
      anchor: { file: 'src/foo.ts', line_range: [2, 2], code_hash: codeHash },
    });

    const changedContent = 'line1\nmodified line 2\nline3';
    expect(verifyAnchorHash(entry, changedContent)).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// Helper — minimal YAML stringify for test setup
// ---------------------------------------------------------------------------

import { stringify as yamlStringify } from 'yaml';

// ---------------------------------------------------------------------------
// doc 16 PR 1 — store durability & migrate-on-read
// ---------------------------------------------------------------------------

describe('doc 16 PR 1 — store durability & migration', () => {
  it('writes to the .anatoly/state/ root, not inside state/internal-docs/', () => {
    saveDocConflicts(tmpDir, makeValidLock([makeEntry()]));
    expect(existsSync(docConflictsPath(tmpDir))).toBe(true);
    expect(existsSync(legacyDocConflictsPath(tmpDir))).toBe(false);
  });

  it('survives a scaffold rebuild that wipes state/internal-docs/', () => {
    saveDocConflicts(tmpDir, makeValidLock([makeEntry({ verdict: 'doc-wins', status: 'applied' })]));

    // Simulate `anatoly docs scaffold internal`: rmSync of the internal-docs dir.
    mkdirSync(legacyDocConflictsDir(tmpDir), { recursive: true });
    rmSync(legacyDocConflictsDir(tmpDir), { recursive: true, force: true });

    const reloaded = loadDocConflicts(tmpDir);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.entries[0].verdict).toBe('doc-wins');
  });

  it('migrates a valid legacy file forward on first load (write-through)', () => {
    mkdirSync(legacyDocConflictsDir(tmpDir), { recursive: true });
    const legacyLock = makeValidLock([makeEntry({ verdict: 'code-wins', status: 'applied' })]);
    writeFileSync(legacyDocConflictsPath(tmpDir), yamlStringify(legacyLock));

    // New path absent → reads legacy and returns it.
    const loaded = loadDocConflicts(tmpDir);
    expect(loaded!.entries[0].verdict).toBe('code-wins');

    // Write-through happened: the durable path now exists.
    expect(existsSync(docConflictsPath(tmpDir))).toBe(true);

    // A subsequent rescaffold (wipes legacy) no longer loses the verdict.
    rmSync(legacyDocConflictsDir(tmpDir), { recursive: true, force: true });
    const reloaded = loadDocConflicts(tmpDir);
    expect(reloaded!.entries[0].verdict).toBe('code-wins');
  });

  it('prefers the new path over a stale legacy file when both exist', () => {
    mkdirSync(legacyDocConflictsDir(tmpDir), { recursive: true });
    writeFileSync(
      legacyDocConflictsPath(tmpDir),
      yamlStringify(makeValidLock([makeEntry({ id: 'legacy', verdict: 'pending' })])),
    );
    saveDocConflicts(tmpDir, makeValidLock([makeEntry({ id: 'current', verdict: 'doc-wins', status: 'applied' })]));

    const loaded = loadDocConflicts(tmpDir);
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0].id).toBe('current');
  });

  it('still throws the same actionable error on a malformed legacy file', () => {
    mkdirSync(legacyDocConflictsDir(tmpDir), { recursive: true });
    writeFileSync(legacyDocConflictsPath(tmpDir), yamlStringify({ version: 99, entries: [] }));
    expect(() => loadDocConflicts(tmpDir)).toThrow(/unsupported version 99/);
  });

  it('returns null when neither the new nor the legacy file exists', () => {
    expect(loadDocConflicts(tmpDir)).toBeNull();
  });
});
