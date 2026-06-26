// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hoisted controls for the @clack/prompts + spawnSync mocks that runHints uses.
// (vi.mock factories run before the module body, so their state must be hoisted.)
const mocks = vi.hoisted(() => ({
  selectValue: { current: 'discard' as unknown },
  spawnSync: vi.fn(() => ({ status: 0 }) as { status?: number | null; error?: Error }),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@clack/prompts', () => ({
  note: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(async () => mocks.selectValue.current),
  isCancel: (v: unknown) => typeof v === 'symbol',
  log: mocks.log,
}));

vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }));

import {
  detectHints,
  loadDismissedHints,
  saveDismissedHint,
  runHints,
} from './hint-detector.js';

describe('detectHints', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'anatoly-hints-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // Story 48.7: no-init hint removed — first-run wizard handles missing config now
  it('does not emit no-init hint even when .anatoly.yml is missing', () => {
    const hints = detectHints({ projectRoot, ragEnabled: false, telegramEnabled: true });
    expect(hints.map((h) => h.id)).not.toContain('no-init');
  });

  // Lite-can-upgrade hint and the post-audit education hint were removed: the
  // first-run wizard's Comparison table is now the single educational surface
  // for embedding tier choice.
  it('does not emit lite-rag-can-upgrade hint anymore', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({
      projectRoot,
      ragEnabled: true,
      resolvedRagMode: 'lite',
      telegramEnabled: true,
    });
    expect(hints.map((h) => h.id)).not.toContain('lite-rag-can-upgrade');
  });

  it('emits no-telegram-bot hint when Telegram notifications are disabled', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({ projectRoot, ragEnabled: false, telegramEnabled: false });
    expect(hints.map((h) => h.id)).toContain('no-telegram-bot');
    const bot = hints.find((h) => h.id === 'no-telegram-bot');
    expect(bot?.command?.argv).toEqual(['init', '--notifications']);
  });

  it('omits no-telegram-bot hint when Telegram notifications are enabled', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({ projectRoot, ragEnabled: false, telegramEnabled: true });
    expect(hints.map((h) => h.id)).not.toContain('no-telegram-bot');
  });

  it('emits fixtures-in-scope hint when a fixture-shaped file is in scope', () => {
    const hints = detectHints({
      projectRoot,
      ragEnabled: false,
      telegramEnabled: true,
      inScopeFiles: ['src/app.ts', 'src/prompts/__gold-set__/terrible-1.ts', 'src/__fixtures__/dead.ts'],
    });
    expect(hints.map((h) => h.id)).toContain('fixtures-in-scope');
    const h = hints.find((x) => x.id === 'fixtures-in-scope');
    expect(h?.command?.argv).toEqual(['init', '--scope']);
    expect(h?.title).toContain('2 fixture files');
  });

  it('omits fixtures-in-scope hint when scope is clean or omitted', () => {
    expect(
      detectHints({ projectRoot, ragEnabled: false, telegramEnabled: true, inScopeFiles: ['src/app.ts'] })
        .map((h) => h.id),
    ).not.toContain('fixtures-in-scope');
    expect(
      detectHints({ projectRoot, ragEnabled: false, telegramEnabled: true })
        .map((h) => h.id),
    ).not.toContain('fixtures-in-scope');
  });
});

describe('hint dismissal persistence', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'anatoly-hints-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns an empty set when no dismissal file exists', () => {
    expect(loadDismissedHints(projectRoot).size).toBe(0);
  });

  it('persists and reloads dismissals', () => {
    saveDismissedHint(projectRoot, 'no-init');
    saveDismissedHint(projectRoot, 'lite-rag-can-upgrade');

    const reloaded = loadDismissedHints(projectRoot);
    expect(reloaded.has('no-init')).toBe(true);
    expect(reloaded.has('lite-rag-can-upgrade')).toBe(true);

    const filePath = join(projectRoot, '.anatoly', 'state', 'hints-dismissed.json');
    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as { dismissed: string[] };
    expect(data.dismissed.sort()).toEqual(['lite-rag-can-upgrade', 'no-init']);
  });

  it('is idempotent: dismissing the same hint twice keeps a single entry', () => {
    saveDismissedHint(projectRoot, 'no-init');
    saveDismissedHint(projectRoot, 'no-init');
    expect([...loadDismissedHints(projectRoot)]).toEqual(['no-init']);
  });
});

describe('runHints — running a command continues the run', () => {
  let projectRoot: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'anatoly-hints-'));
    mocks.spawnSync.mockClear();
    mocks.log.error.mockClear();
    mocks.selectValue.current = 'discard';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    exitSpy.mockRestore();
  });

  it('spawns the suggested command then resumes without exiting', async () => {
    // Telegram disabled → the no-telegram-bot hint (with an `init --notifications`
    // command) fires; choosing "run" must launch it and then continue the run.
    mocks.selectValue.current = 'run';
    mocks.spawnSync.mockReturnValue({ status: 0 });

    await runHints({ projectRoot, ragEnabled: false, telegramEnabled: false });

    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    const argv = (mocks.spawnSync.mock.calls[0] as unknown as unknown[])[1] as string[];
    expect(argv).toEqual(expect.arrayContaining(['init', '--notifications']));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('continues the run even when the spawned command fails to launch', async () => {
    mocks.selectValue.current = 'run';
    mocks.spawnSync.mockReturnValue({ error: new Error('ENOENT') });

    await runHints({ projectRoot, ragEnabled: false, telegramEnabled: false });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
  });
});

