// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectHints,
  loadDismissedHints,
  saveDismissedHint,
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
    expect(bot?.command?.argv).toEqual(['notifications', 'create-bot']);
  });

  it('omits no-telegram-bot hint when Telegram notifications are enabled', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({ projectRoot, ragEnabled: false, telegramEnabled: true });
    expect(hints.map((h) => h.id)).not.toContain('no-telegram-bot');
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

    const filePath = join(projectRoot, '.anatoly', 'hints-dismissed.json');
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

