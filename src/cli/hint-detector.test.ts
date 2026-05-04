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
import type { HardwareProfile } from '../rag/hardware-detect.js';

const capableHardware: HardwareProfile = {
  totalMemoryGB: 64,
  cpuCores: 16,
  hasGpu: true,
  gpuType: 'cuda',
  vramGB: 24,
  hasDocker: true,
  hasNvidiaContainerToolkit: true,
};

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

  it('emits lite-rag-can-upgrade hint when hardware supports advanced backend', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({
      projectRoot,
      ragEnabled: true,
      resolvedRagMode: 'lite',
      hardware: capableHardware,
      telegramEnabled: true,
    });
    expect(hints.map((h) => h.id)).toContain('lite-rag-can-upgrade');
    const upgrade = hints.find((h) => h.id === 'lite-rag-can-upgrade');
    expect(upgrade?.command?.argv).toEqual(['setup-embeddings']);
  });

  it('omits lite-rag hint when already on advanced backend', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({
      projectRoot,
      ragEnabled: true,
      resolvedRagMode: 'advanced',
      hardware: capableHardware,
      telegramEnabled: true,
    });
    expect(hints.map((h) => h.id)).not.toContain('lite-rag-can-upgrade');
  });

  it('omits lite-rag hint when RAG is disabled', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({
      projectRoot,
      ragEnabled: false,
      resolvedRagMode: 'lite',
      hardware: capableHardware,
      telegramEnabled: true,
    });
    expect(hints.map((h) => h.id)).not.toContain('lite-rag-can-upgrade');
  });

  it('omits lite-rag hint when GPU is missing', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({
      projectRoot,
      ragEnabled: true,
      resolvedRagMode: 'lite',
      hardware: { ...capableHardware, hasGpu: false, gpuType: undefined, vramGB: undefined },
      telegramEnabled: true,
    });
    expect(hints.map((h) => h.id)).not.toContain('lite-rag-can-upgrade');
  });

  it('omits lite-rag hint when VRAM is below threshold', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({
      projectRoot,
      ragEnabled: true,
      resolvedRagMode: 'lite',
      hardware: { ...capableHardware, vramGB: 8 },
      telegramEnabled: true,
    });
    expect(hints.map((h) => h.id)).not.toContain('lite-rag-can-upgrade');
  });

  it('still emits lite-rag hint when Docker / NVIDIA toolkit are missing (deps are installed via setup-embeddings)', () => {
    writeFileSync(join(projectRoot, '.anatoly.yml'), 'providers: {}\n');
    const hints = detectHints({
      projectRoot,
      ragEnabled: true,
      resolvedRagMode: 'lite',
      hardware: { ...capableHardware, hasDocker: false, hasNvidiaContainerToolkit: false },
      telegramEnabled: true,
    });
    expect(hints.map((h) => h.id)).toContain('lite-rag-can-upgrade');
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
