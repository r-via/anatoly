// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HardwareProfile } from '../rag/hardware-detect.js';
import { runFirstRunWizard, runLitePrefetch, runGgufPrefetch, runLocalEmbeddingsUpgradeSubprocess, writeFirstRunConfig, runEndOfSetupPrompt, type WizardOptions, type EndOfSetupOptions } from './setup-prompts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const capableHardware: HardwareProfile = {
  totalMemoryGB: 64,
  cpuCores: 16,
  hasGpu: true,
  gpuType: 'cuda',
  vramGB: 24,
  hasDocker: true,
  hasNvidiaContainerToolkit: true,
};

const incapableHardware: HardwareProfile = {
  totalMemoryGB: 16,
  cpuCores: 8,
  hasGpu: false,
};

const lowVramHardware: HardwareProfile = {
  totalMemoryGB: 32,
  cpuCores: 12,
  hasGpu: true,
  gpuType: 'cuda',
  vramGB: 8,
};

function baseOpts(overrides?: Partial<WizardOptions>): WizardOptions {
  return {
    hardware: incapableHardware,
    isTTY: true,
    defaultsSettings: false,
    quickWin: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock @clack/prompts — track calls and simulate user hitting Enter (defaults)
// ---------------------------------------------------------------------------

const selectMock = vi.fn<(opts: { message: string; options: Array<{ value: string; label?: string; hint?: string }> }) => Promise<string | symbol>>();
const textMock = vi.fn<(opts: { message: string; initialValue?: string; validate?: (value: string) => string | undefined }) => Promise<string | symbol>>();
const noteMock = vi.fn();
const cancelMock = vi.fn();
const spinnerStartMock = vi.fn();
const spinnerStopMock = vi.fn();
const spinnerMessageMock = vi.fn();
const spinnerMock = vi.fn(() => ({
  start: spinnerStartMock,
  stop: spinnerStopMock,
  message: spinnerMessageMock,
}));

vi.mock('@clack/prompts', () => ({
  select: (opts: { message: string; options: Array<{ value: string; label?: string; hint?: string }> }) => selectMock(opts),
  text: (opts: { message: string; initialValue?: string; validate?: (value: string) => string | undefined }) => textMock(opts),
  note: (...args: unknown[]) => noteMock(...args),
  cancel: (...args: unknown[]) => cancelMock(...args),
  isCancel: (val: unknown) => typeof val === 'symbol',
  spinner: () => spinnerMock(),
}));

// Mock embeddings-prefetch to avoid real network calls
const prefetchMock = vi.fn<(opts?: { onProgress?: (ev: unknown) => void }) => Promise<void>>();
vi.mock('../rag/embeddings-prefetch.js', () => ({
  prefetchLiteModels: (opts?: { onProgress?: (ev: unknown) => void }) => prefetchMock(opts),
}));

// Mock gguf-prefetch to avoid real network calls
const ggufPrefetchMock = vi.fn<(opts?: { onProgress?: (ev: unknown) => void }) => Promise<void>>();
vi.mock('../rag/gguf-prefetch.js', () => ({
  prefetchGgufModels: (opts?: { onProgress?: (ev: unknown) => void }) => ggufPrefetchMock(opts),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Mock child_process.spawnSync for `local-embeddings upgrade` subprocess tests
const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Mock tryOpenFile from ../utils/open.js
const tryOpenFileMock = vi.fn<(path: string) => Promise<boolean>>();
vi.mock('../utils/open.js', () => ({
  tryOpenFile: (path: string) => tryOpenFileMock(path),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFirstRunWizard', () => {
  beforeEach(() => {
    selectMock.mockReset();
    textMock.mockReset();
    noteMock.mockReset();
    cancelMock.mockReset();
    prefetchMock.mockReset();
    spinnerStartMock.mockReset();
    spinnerStopMock.mockReset();
    spinnerMessageMock.mockReset();
  });

  // AC: --defaults-settings OR non-TTY → silent { tier: 'lite', mode: 'full-run' }
  describe('non-interactive mode (defaults-settings or non-TTY)', () => {
    it('returns lite/full-run when defaultsSettings is true', async () => {
      const result = await runFirstRunWizard(baseOpts({ defaultsSettings: true }));
      expect(result).toEqual({ tier: 'lite', mode: 'full-run' });
      expect(selectMock).not.toHaveBeenCalled();
    });

    it('returns lite/full-run when isTTY is false', async () => {
      const result = await runFirstRunWizard(baseOpts({ isTTY: false }));
      expect(result).toEqual({ tier: 'lite', mode: 'full-run' });
      expect(selectMock).not.toHaveBeenCalled();
    });

    it('returns lite/full-run even when --quick-win is set alongside --defaults-settings', async () => {
      const result = await runFirstRunWizard(baseOpts({ defaultsSettings: true, quickWin: true }));
      // --defaults-settings overrides everything: CI wants full-run
      expect(result).toEqual({ tier: 'lite', mode: 'full-run' });
      expect(selectMock).not.toHaveBeenCalled();
    });
  });

  // AC: Enter on both prompts → { tier: 'lite', mode: 'quick-win' }
  describe('interactive mode — default selections (Enter, Enter)', () => {
    it('returns lite/quick-win when user hits Enter on both prompts', async () => {
      // First select (tier) → return the first value (lite)
      selectMock.mockResolvedValueOnce('lite');
      // Second select (mode) → return the first value (quick-win)
      selectMock.mockResolvedValueOnce('quick-win');

      const result = await runFirstRunWizard(baseOpts());
      expect(result).toEqual({ tier: 'lite', mode: 'quick-win' });
      expect(selectMock).toHaveBeenCalledTimes(2);
    });
  });

  // AC: Hardware without GPU → Default + External options shown, note explaining why advanced unavailable
  describe('incapable hardware (no CUDA GPU)', () => {
    it('shows Default and External options for tier prompt (no Advanced)', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: incapableHardware }));

      const tierCall = selectMock.mock.calls[0]![0];
      expect(tierCall.options).toHaveLength(2);
      expect(tierCall.options[0]!.value).toBe('lite');
      expect(tierCall.options[1]!.value).toBe('external');
    });

    it('does not render the comparison table when advanced is not available', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: incapableHardware }));

      const comparisonNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('ONNX CPU'),
      );
      expect(comparisonNote).toBeUndefined();
    });
  });

  // AC: Hardware with low VRAM → same as incapable (no Advanced, but External available)
  describe('low VRAM hardware (CUDA but < 12 GB)', () => {
    it('shows Default and External options for tier prompt (no Advanced)', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: lowVramHardware }));

      const tierCall = selectMock.mock.calls[0]![0];
      expect(tierCall.options).toHaveLength(2);
      expect(tierCall.options[0]!.value).toBe('lite');
      expect(tierCall.options[1]!.value).toBe('external');
    });
  });

  // AC: Hardware with GPU CUDA + ≥ 12 GB VRAM → all three options shown
  describe('capable hardware (CUDA GPU + ≥ 12 GB VRAM)', () => {
    it('shows Default, Advanced, and External options for tier prompt', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware }));

      const tierCall = selectMock.mock.calls[0]![0];
      expect(tierCall.options).toHaveLength(3);
      expect(tierCall.options[0]!.value).toBe('lite');
      expect(tierCall.options[1]!.value).toBe('advanced');
      expect(tierCall.options[2]!.value).toBe('external');
    });

    it('does not show the unavailability note', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware }));

      // Note should not contain "Advanced not available"
      const unavailNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Advanced not available'),
      );
      expect(unavailNote).toBeUndefined();
    });

    it('returns advanced when user selects advanced tier', async () => {
      selectMock.mockResolvedValueOnce('advanced');
      selectMock.mockResolvedValueOnce('full-run');

      const result = await runFirstRunWizard(baseOpts({ hardware: capableHardware }));
      expect(result).toEqual({ tier: 'advanced', mode: 'full-run' });
    });
  });

  // AC: Mode prompt shows two options with descriptions
  describe('mode prompt', () => {
    it('presents Quick Win and Full Run options', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts());

      const modeCall = selectMock.mock.calls[1]![0];
      expect(modeCall.options).toHaveLength(2);
      expect(modeCall.options[0]!.value).toBe('quick-win');
      expect(modeCall.options[1]!.value).toBe('full-run');
    });
  });

  // AC: --quick-win flag → mode prompt skipped, mode forced to 'quick-win'
  describe('--quick-win flag', () => {
    it('skips mode prompt and forces quick-win mode', async () => {
      selectMock.mockResolvedValueOnce('lite');

      const result = await runFirstRunWizard(baseOpts({ quickWin: true }));
      expect(result).toEqual({ tier: 'lite', mode: 'quick-win' });
      // Only tier prompt shown, mode prompt skipped
      expect(selectMock).toHaveBeenCalledTimes(1);
    });

    it('still shows tier prompt on capable hardware', async () => {
      selectMock.mockResolvedValueOnce('advanced');

      const result = await runFirstRunWizard(baseOpts({ hardware: capableHardware, quickWin: true }));
      expect(result).toEqual({ tier: 'advanced', mode: 'quick-win' });
      expect(selectMock).toHaveBeenCalledTimes(1);
    });
  });

  // AC: When `.anatoly/embeddings-ready.json` already exists (e.g. user ran
  // `anatoly local-embeddings upgrade` standalone), the wizard skips the tier
  // prompt and adopts the recorded backend.
  describe('ready-flag short-circuit', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'wizard-ready-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function writeReadyFlag(backend: 'advanced-gguf' | 'lite' | 'external'): void {
      mkdirSync(join(dir, '.anatoly'), { recursive: true });
      writeFileSync(
        join(dir, '.anatoly', 'embeddings-ready.json'),
        JSON.stringify({ backend, device: 'cpu', setup_at: new Date().toISOString() }),
        'utf-8',
      );
    }

    it('skips tier prompt and returns advanced when flag is advanced-gguf', async () => {
      writeReadyFlag('advanced-gguf');
      selectMock.mockResolvedValueOnce('full-run');

      const result = await runFirstRunWizard(baseOpts({ projectRoot: dir }));

      expect(result).toEqual({ tier: 'advanced', mode: 'full-run' });
      // Only the mode prompt should fire — tier prompt is skipped.
      expect(selectMock).toHaveBeenCalledTimes(1);
      expect(selectMock.mock.calls[0]![0].message).toMatch(/audit mode/i);
    });

    it('skips both prompts and returns external when flag is external', async () => {
      writeReadyFlag('external');

      const result = await runFirstRunWizard(baseOpts({ projectRoot: dir }));

      expect(result).toEqual({ tier: 'external', mode: 'full-run' });
      expect(selectMock).not.toHaveBeenCalled();
    });

    it('skips tier prompt and returns lite when flag is lite', async () => {
      writeReadyFlag('lite');
      selectMock.mockResolvedValueOnce('full-run');

      const result = await runFirstRunWizard(baseOpts({ projectRoot: dir }));

      expect(result).toEqual({ tier: 'lite', mode: 'full-run' });
      expect(selectMock).toHaveBeenCalledTimes(1);
    });

    it('falls through to normal flow when flag is missing', async () => {
      // No writeReadyFlag — empty project root.
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('full-run');

      await runFirstRunWizard(baseOpts({ projectRoot: dir }));

      // Both tier and mode prompts fire.
      expect(selectMock).toHaveBeenCalledTimes(2);
    });

    it('honours --quick-win when short-circuiting on advanced flag', async () => {
      writeReadyFlag('advanced-gguf');

      const result = await runFirstRunWizard(baseOpts({ projectRoot: dir, quickWin: true }));

      expect(result).toEqual({ tier: 'advanced', mode: 'quick-win' });
      expect(selectMock).not.toHaveBeenCalled();
    });
  });

  // AC: Ctrl+C during any prompt → process.exit(0)
  describe('Ctrl+C handling', () => {
    it('exits when user cancels tier prompt', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      selectMock.mockResolvedValueOnce(Symbol('cancel') as unknown as string);

      await runFirstRunWizard(baseOpts());

      expect(cancelMock).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
    });

    it('exits when user cancels mode prompt', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce(Symbol('cancel') as unknown as string);

      await runFirstRunWizard(baseOpts());

      expect(cancelMock).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
    });
  });

  // AC: Tier prompt has comparison table (informational — check note is printed)
  describe('tier comparison table', () => {
    it('prints a comparison note before the tier prompt on capable hardware', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware }));

      // Should print a note with the comparison table
      const comparisonNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('ONNX'),
      );
      expect(comparisonNote).toBeDefined();
    });
  });

  // Story 49.5: Value notice
  describe('value notice', () => {
    // AC2: snapshot-style test verifying exact text content
    it('renders note with exact value text', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware }));

      const valueNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('Embeddings power'),
      );
      expect(valueNote).toBeDefined();
      // Snapshot: exact text content (may include ANSI from chalk.dim)
      expect(valueNote![0]).toContain(
        'Embeddings power Anatoly\'s retrieval — better recall means sharper, more grounded findings.',
      );
    });

    // AC3: --plain → note is shown without chalk.dim wrapping
    it('renders value note without chalk.dim when plain is true', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware, plain: true }));

      const valueNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('Embeddings power'),
      );
      expect(valueNote).toBeDefined();
      // In plain mode, the text should be passed without ANSI escapes
      const text = valueNote![0] as string;
      expect(text).toBe('Embeddings power Anatoly\'s retrieval — better recall means sharper, more grounded findings.');
    });

    // AC1: notice is shown on incapable hardware too (always before select)
    it('shows value notice even on incapable hardware', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('full-run');

      await runFirstRunWizard(baseOpts({ hardware: incapableHardware }));

      const valueNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('Embeddings power'),
      );
      expect(valueNote).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // savedPreference integration (Story 49.2)
  // ---------------------------------------------------------------------------

  describe('savedPreference', () => {
    // AC2: preference=advanced + capable hardware + no CLI override → skip prompt, return advanced
    it('skips tier prompt when savedPreference is advanced and hardware is capable', async () => {
      selectMock.mockResolvedValueOnce('quick-win'); // mode prompt only

      const result = await runFirstRunWizard(baseOpts({
        hardware: capableHardware,
        savedPreference: 'advanced',
      }));

      expect(result.tier).toBe('advanced');
      // Tier select should NOT be called — only mode select
      expect(selectMock).toHaveBeenCalledTimes(1);
      expect(selectMock.mock.calls[0]![0].message).toContain('mode');
    });

    // AC3: preference=advanced + incapable hardware → show note, fall through to prompt
    it('shows fallback note and re-displays tier prompt when hardware is incapable', async () => {
      selectMock.mockResolvedValueOnce('lite'); // tier prompt (re-shown)
      selectMock.mockResolvedValueOnce('full-run'); // mode prompt

      const result = await runFirstRunWizard(baseOpts({
        hardware: incapableHardware,
        savedPreference: 'advanced',
      }));

      expect(result.tier).toBe('lite');
      // Should have shown a note about preference not supported
      const fallbackNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('saved preference'),
      );
      expect(fallbackNote).toBeDefined();
      // Tier select should be called (re-shown)
      expect(selectMock).toHaveBeenCalledTimes(2);
    });

    // AC4: CLI override set → ignore preferences
    it('ignores savedPreference when cliTierOverride is true', async () => {
      selectMock.mockResolvedValueOnce('lite'); // tier prompt
      selectMock.mockResolvedValueOnce('full-run'); // mode prompt

      const result = await runFirstRunWizard(baseOpts({
        hardware: capableHardware,
        savedPreference: 'advanced',
        cliTierOverride: true,
      }));

      expect(result.tier).toBe('lite');
      // Tier prompt SHOULD be shown (preference ignored)
      expect(selectMock).toHaveBeenCalledTimes(2);
    });

    // AC3: preference=advanced + low VRAM hardware → show note, fall through
    it('shows fallback note when hardware has low VRAM', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('full-run');

      await runFirstRunWizard(baseOpts({
        hardware: lowVramHardware,
        savedPreference: 'advanced',
      }));

      const fallbackNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('saved preference'),
      );
      expect(fallbackNote).toBeDefined();
    });

    // No preference → normal flow (select tier)
    it('shows tier prompt normally when no savedPreference', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('full-run');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware }));

      // 2 select calls: tier + mode
      expect(selectMock).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Story 49.6: Plain-mode parity for comparison table
  // ---------------------------------------------------------------------------

  describe('plain-mode comparison table (Story 49.6)', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      selectMock.mockReset();
      noteMock.mockReset();
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    // AC1: plain → comparison table rendered via console.log, not p.note
    it('renders comparison table via console.log (not p.note) in plain mode', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware, plain: true }));

      // p.note should NOT be called with comparison table content
      const comparisonNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('ONNX'),
      );
      expect(comparisonNote).toBeUndefined();

      // console.log should contain the plain comparison table
      const allOutput = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(allOutput).toContain('ONNX CPU');
      expect(allOutput).toContain('GGUF GPU');
    });

    it('lists all three tiers (lite/advanced/external) when capable hardware is detected', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware, plain: true }));

      const allOutput = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(allOutput).toContain('ONNX CPU');
      expect(allOutput).toContain('GGUF GPU');
      expect(allOutput).toContain('third-party');
    });

    // AC1: no ANSI escape sequences in plain table output
    it('contains no ANSI escape sequences in plain mode', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware, plain: true }));

      const allOutput = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      const tableLines = allOutput.split('\n').filter(
        (l: string) => l.includes('ONNX') || l.includes('GGUF') || l.includes('Embeddings setup'),
      );
      for (const line of tableLines) {
        expect(line).not.toMatch(/\x1b\[/);
      }
    });

    // AC1: no Unicode beyond ASCII in plain table
    it('uses only ASCII characters in plain table', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware, plain: true }));

      const allOutput = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      const tableLines = allOutput.split('\n').filter(
        (l: string) => l.includes('ONNX') || l.includes('GGUF') || l.includes('Embeddings setup'),
      );
      for (const line of tableLines) {
        expect(line).toMatch(/^[\x20-\x7E]*$/); // printable ASCII only
      }
    });

    // AC2: normal TTY mode → existing p.note behavior unchanged
    it('renders comparison table via p.note in normal mode (unchanged)', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware }));

      const comparisonNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('ONNX'),
      );
      expect(comparisonNote).toBeDefined();
    });

    // AC3/AC4: structured readable lines (header + two data lines)
    it('plain table has header and two independently parseable data lines', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware, plain: true }));

      const allOutput = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(allOutput).toContain('Embeddings setup:');

      const lines = allOutput.split('\n');
      const liteLine = lines.find((l: string) => /^lite\s/.test(l));
      const advancedLine = lines.find((l: string) => /^advanced\s/.test(l));
      expect(liteLine).toBeDefined();
      expect(advancedLine).toBeDefined();
    });
  });
});


// ---------------------------------------------------------------------------
// runLitePrefetch tests
// ---------------------------------------------------------------------------

describe('runLitePrefetch', () => {
  beforeEach(() => {
    prefetchMock.mockReset();
    spinnerStartMock.mockReset();
    spinnerStopMock.mockReset();
    spinnerMessageMock.mockReset();
  });

  // AC: interactive TTY → spinner used
  it('uses a spinner in interactive mode', async () => {
    prefetchMock.mockResolvedValue(undefined);

    await runLitePrefetch({ isTTY: true, defaultsSettings: false });

    expect(spinnerStartMock).toHaveBeenCalledWith(expect.stringContaining('embedding'));
    expect(spinnerStopMock).toHaveBeenCalledWith(expect.stringContaining('ready'));
  });

  // AC: --defaults-settings → no spinner, linear log
  it('skips spinner when defaultsSettings is true', async () => {
    prefetchMock.mockResolvedValue(undefined);

    await runLitePrefetch({ isTTY: true, defaultsSettings: true });

    expect(spinnerStartMock).not.toHaveBeenCalled();
  });

  // AC: non-TTY → no spinner, linear log
  it('skips spinner when isTTY is false', async () => {
    prefetchMock.mockResolvedValue(undefined);

    await runLitePrefetch({ isTTY: false, defaultsSettings: false });

    expect(spinnerStartMock).not.toHaveBeenCalled();
  });

  // AC: progress events update the spinner message
  it('updates spinner message on progress events', async () => {
    prefetchMock.mockImplementation(async (opts) => {
      opts?.onProgress?.({ kind: 'initiate', modelId: 'test', file: 'model.onnx' });
      opts?.onProgress?.({ kind: 'progress', modelId: 'test', file: 'model.onnx', percent: 50 });
    });

    await runLitePrefetch({ isTTY: true, defaultsSettings: false });

    expect(spinnerMessageMock).toHaveBeenCalledWith(expect.stringContaining('model.onnx'));
    expect(spinnerMessageMock).toHaveBeenCalledWith(expect.stringContaining('50%'));
  });

  // AC: prefetch calls prefetchLiteModels
  it('calls prefetchLiteModels', async () => {
    prefetchMock.mockResolvedValue(undefined);

    await runLitePrefetch({ isTTY: true, defaultsSettings: false });

    expect(prefetchMock).toHaveBeenCalledTimes(1);
  });

  // AC: asFallback=true reframes the messages so the user understands lite is
  //     a backup, not the primary backend (advanced is still the choice).
  it('uses fallback-framed messages when asFallback is true', async () => {
    prefetchMock.mockResolvedValue(undefined);

    await runLitePrefetch({ isTTY: true, defaultsSettings: false, asFallback: true });

    expect(spinnerStartMock).toHaveBeenCalledWith(expect.stringContaining('fallback'));
    expect(spinnerStopMock).toHaveBeenCalledWith(expect.stringContaining('fallback'));
    expect(spinnerStopMock).not.toHaveBeenCalledWith('Embeddings (lite) ready');
  });

  it('keeps the primary-framed messages when asFallback is unset', async () => {
    prefetchMock.mockResolvedValue(undefined);

    await runLitePrefetch({ isTTY: true, defaultsSettings: false });

    expect(spinnerStopMock).toHaveBeenCalledWith('Embeddings (lite) ready');
  });
});

// ---------------------------------------------------------------------------
// runGgufPrefetch tests
// ---------------------------------------------------------------------------

describe('runGgufPrefetch', () => {
  beforeEach(() => {
    ggufPrefetchMock.mockReset();
    spinnerStartMock.mockReset();
    spinnerStopMock.mockReset();
    spinnerMessageMock.mockReset();
  });

  // AC: interactive TTY → spinner used
  it('uses a spinner in interactive mode', async () => {
    ggufPrefetchMock.mockResolvedValue(undefined);

    const result = await runGgufPrefetch({ isTTY: true, defaultsSettings: false });

    expect(spinnerStartMock).toHaveBeenCalledWith(expect.stringContaining('GGUF'));
    expect(spinnerStopMock).toHaveBeenCalledWith(expect.stringContaining('ready'));
    expect(result).toEqual({ ok: true, lastError: undefined });
  });

  // AC: returns ok:true on success
  it('returns ok:true when all downloads succeed', async () => {
    ggufPrefetchMock.mockResolvedValue(undefined);

    const result = await runGgufPrefetch({ isTTY: false, defaultsSettings: false });
    expect(result).toEqual({ ok: true, lastError: undefined });
  });

  // AC: returns ok:false with lastError when a download fails
  it('returns ok:false with lastError when a download error event fires', async () => {
    const dlError = new Error('Network error');
    ggufPrefetchMock.mockImplementation(async (opts) => {
      opts?.onProgress?.({ kind: 'error', filename: 'model.gguf', error: dlError });
    });

    const result = await runGgufPrefetch({ isTTY: true, defaultsSettings: false });
    expect(result).toEqual({ ok: false, lastError: dlError });
    expect(spinnerStopMock).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  // AC: --defaults-settings → no spinner
  it('skips spinner when defaultsSettings is true', async () => {
    ggufPrefetchMock.mockResolvedValue(undefined);

    await runGgufPrefetch({ isTTY: true, defaultsSettings: true });

    expect(spinnerStartMock).not.toHaveBeenCalled();
  });

  // AC: progress events update spinner
  it('updates spinner message on progress events', async () => {
    ggufPrefetchMock.mockImplementation(async (opts) => {
      opts?.onProgress?.({
        kind: 'progress',
        filename: 'nomic.gguf',
        downloadedMB: 500,
        totalMB: 5000,
        percent: 10,
      });
    });

    await runGgufPrefetch({ isTTY: true, defaultsSettings: false });

    expect(spinnerMessageMock).toHaveBeenCalledWith(expect.stringContaining('nomic.gguf'));
    expect(spinnerMessageMock).toHaveBeenCalledWith(expect.stringContaining('10%'));
  });
});

// ---------------------------------------------------------------------------
// runLocalEmbeddingsUpgradeSubprocess tests
// ---------------------------------------------------------------------------

describe('runLocalEmbeddingsUpgradeSubprocess', () => {
  const origArgv0 = process.argv[0];
  const origArgv1 = process.argv[1];

  beforeEach(() => {
    spawnSyncMock.mockReset();
    process.argv[0] = '/usr/bin/node';
    process.argv[1] = '/usr/local/bin/anatoly';
  });

  afterEach(() => {
    process.argv[0] = origArgv0!;
    process.argv[1] = origArgv1!;
  });

  // AC: Given story 48.3 has downloaded GGUF models, when the subprocess is
  // launched, then spawnSync('node', ['anatoly', 'local-embeddings', 'upgrade'])
  // is executed with stdio inherited.
  it('spawns the local-embeddings upgrade subprocess with stdio inherit', () => {
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined });

    const result = runLocalEmbeddingsUpgradeSubprocess('/tmp/project');

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/usr/local/bin/anatoly', 'local-embeddings', 'upgrade'],
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({ ANATOLY_PROJECT_ROOT: '/tmp/project' }),
      }),
    );
    expect(result).toEqual({ ok: true, exitCode: 0 });
  });

  // AC: Given subprocess exit code 0, When the parent resumes, Then { ok: true, exitCode: 0 }
  it('returns ok true when subprocess exits with code 0', () => {
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined });

    const result = runLocalEmbeddingsUpgradeSubprocess('/tmp/project');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  // AC: Given subprocess exits with non-zero code, When the parent resumes,
  // Then { ok: false, exitCode: <code> }
  it('returns ok false when subprocess exits with non-zero code', () => {
    spawnSyncMock.mockReturnValue({ status: 1, error: undefined });

    const result = runLocalEmbeddingsUpgradeSubprocess('/tmp/project');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  // AC: Given subprocess returns null status (killed by signal), Then ok false, exitCode -1
  it('returns ok false with exitCode -1 when status is null (signal kill)', () => {
    spawnSyncMock.mockReturnValue({ status: null, error: new Error('SIGTERM') });

    const result = runLocalEmbeddingsUpgradeSubprocess('/tmp/project');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
  });

  // AC: Given process.argv[0] is undefined, When the subprocess tries to spawn,
  // Then an AnatolyError is thrown
  it('throws AnatolyError when process.argv[0] is undefined', () => {
    process.argv[0] = undefined as unknown as string;

    expect(() => runLocalEmbeddingsUpgradeSubprocess('/tmp/project'))
      .toThrow(/Cannot resolve anatoly CLI binary path/);
  });

  // AC: Given process.argv[1] is undefined, When the subprocess tries to spawn,
  // Then an AnatolyError is thrown
  it('throws AnatolyError when process.argv[1] is undefined', () => {
    process.argv[1] = undefined as unknown as string;

    expect(() => runLocalEmbeddingsUpgradeSubprocess('/tmp/project'))
      .toThrow(/Cannot resolve anatoly CLI binary path/);
  });

  // AC: passes ANATOLY_PROJECT_ROOT in env
  it('passes ANATOLY_PROJECT_ROOT as the projectRoot argument', () => {
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined });

    runLocalEmbeddingsUpgradeSubprocess('/home/user/myproject');

    const envArg = spawnSyncMock.mock.calls[0]![2].env;
    expect(envArg.ANATOLY_PROJECT_ROOT).toBe('/home/user/myproject');
  });
});

// ---------------------------------------------------------------------------
// writeFirstRunConfig tests
// ---------------------------------------------------------------------------

describe('writeFirstRunConfig', () => {
  let dir: string;
  const origApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'write-config-'));
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = origApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('writes a v3 .anatoly.yml with version: 3 marker', async () => {
    await writeFirstRunConfig(dir);
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toContain('version: 3');
  });

  it('includes header comment at top of file', async () => {
    await writeFirstRunConfig(dir);
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content.startsWith('# Anatoly configuration')).toBe(true);
    expect(content).toContain('generated by first-run wizard');
  });

  it('emits anthropic with auth: oauth when ANTHROPIC_API_KEY is absent', async () => {
    await writeFirstRunConfig(dir);
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as Record<string, unknown>;
    const anthropic = (parsed.providers as Record<string, Record<string, unknown>>).anthropic;
    expect(anthropic.transport).toBe('claude_agent_sdk');
    expect(anthropic.auth).toBe('oauth');
    expect(anthropic.env_key).toBeUndefined();
  });

  it('emits anthropic with auth: api_key + env_key when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    await writeFirstRunConfig(dir);
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as Record<string, unknown>;
    const anthropic = (parsed.providers as Record<string, Record<string, unknown>>).anthropic;
    expect(anthropic.auth).toBe('api_key');
    expect(anthropic.env_key).toBe('ANTHROPIC_API_KEY');
  });

  it('writes all 7 axes as enabled (bool short form) for default tier', async () => {
    await writeFirstRunConfig(dir);
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as {
      evaluation: { axes: Record<string, unknown> };
    };
    for (const axis of ['utility', 'duplication', 'correction', 'overengineering', 'tests', 'best_practices', 'documentation']) {
      expect(parsed.evaluation.axes[axis]).toBe(true);
    }
  });

  it('declares routing.generation slots prefixed with anthropic/', async () => {
    await writeFirstRunConfig(dir);
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as {
      routing: { generation: Record<string, string> };
    };
    expect(parsed.routing.generation.quality).toMatch(/^anthropic\//);
    expect(parsed.routing.generation.fast).toMatch(/^anthropic\//);
    expect(parsed.routing.generation.deliberation).toMatch(/^anthropic\//);
    expect(parsed.routing.generation.summarization).toMatch(/^anthropic\//);
  });

  it('generates a v3 YAML that loadConfig accepts (lite tier)', async () => {
    await writeFirstRunConfig(dir);
    const { loadConfig } = await import('../utils/config-loader.js');
    expect(() => loadConfig(dir)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Lite tier
  // -------------------------------------------------------------------------

  it('lite tier declares local-lite provider with onnxruntime_node transport', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as {
      providers: Record<string, { transport: string; models: string[] }>;
    };
    expect(parsed.providers['local-lite'].transport).toBe('onnxruntime_node');
    expect(parsed.providers['local-lite'].models).toContain('jinaai/jina-embeddings-v2-base-code');
    expect(parsed.providers['local-lite'].models).toContain('Xenova/all-MiniLM-L6-v2');
  });

  it('lite tier points routing.embeddings at local-lite', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as {
      routing: { embeddings: { code: string; text: string } };
    };
    expect(parsed.routing.embeddings.code).toBe('local-lite/jinaai/jina-embeddings-v2-base-code');
    expect(parsed.routing.embeddings.text).toBe('local-lite/Xenova/all-MiniLM-L6-v2');
  });

  it('lite tier does not write embeddings-ready.json', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const flagPath = join(dir, '.anatoly', 'embeddings-ready.json');
    expect(existsSync(flagPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Advanced tier
  // -------------------------------------------------------------------------

  it('advanced tier declares local-advanced provider without a user-facing base_url', async () => {
    await writeFirstRunConfig(dir, { tier: 'advanced' });
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as {
      providers: Record<string, { transport: string; base_url?: string; models: string[] }>;
    };
    expect(parsed.providers['local-advanced'].transport).toBe('openai_compatible');
    // base_url is intentionally omitted: the runtime resolves per-axis URLs
    // (11437/11438) from KNOWN_EMBEDDING_PROVIDERS and swaps the GGUF Docker
    // container on demand.
    expect(parsed.providers['local-advanced'].base_url).toBeUndefined();
    expect(parsed.providers['local-advanced'].models).toContain('nomic-embed-code-gguf');
    expect(parsed.providers['local-advanced'].models).toContain('qwen3-embedding-8b-gguf');
  });

  it('advanced tier points routing.embeddings at local-advanced', async () => {
    await writeFirstRunConfig(dir, { tier: 'advanced' });
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as {
      routing: { embeddings: { code: string; text: string } };
    };
    expect(parsed.routing.embeddings.code).toBe('local-advanced/nomic-embed-code-gguf');
    expect(parsed.routing.embeddings.text).toBe('local-advanced/qwen3-embedding-8b-gguf');
  });

  it('advanced tier YAML loads without throwing', async () => {
    await writeFirstRunConfig(dir, { tier: 'advanced' });
    const { loadConfig } = await import('../utils/config-loader.js');
    expect(() => loadConfig(dir)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // External tier
  // -------------------------------------------------------------------------

  it('external tier declares mistral and openrouter as openai_compatible', async () => {
    await writeFirstRunConfig(dir, { tier: 'external' });
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as {
      providers: Record<string, { transport: string; auth?: string; env_key?: string; models: string[] }>;
    };
    expect(parsed.providers.mistral.transport).toBe('openai_compatible');
    expect(parsed.providers.mistral.auth).toBe('api_key');
    expect(parsed.providers.mistral.env_key).toBe('MISTRAL_API_KEY');
    expect(parsed.providers.mistral.models).toContain('mistral-embed');
    expect(parsed.providers.openrouter.env_key).toBe('OPENROUTER_API_KEY');
    expect(parsed.providers.openrouter.models).toContain('qwen/qwen3-embedding-8b');
  });

  it('external tier points routing.embeddings at mistral + openrouter', async () => {
    await writeFirstRunConfig(dir, { tier: 'external' });
    const yaml = await import('js-yaml');
    const parsed = yaml.load(readFileSync(join(dir, '.anatoly.yml'), 'utf-8')) as {
      routing: { embeddings: { code: string; text: string } };
    };
    expect(parsed.routing.embeddings.code).toBe('mistral/mistral-embed');
    expect(parsed.routing.embeddings.text).toBe('openrouter/qwen/qwen3-embedding-8b');
  });

  it('external tier still writes embeddings-ready.json (legacy compat)', async () => {
    await writeFirstRunConfig(dir, { tier: 'external' });
    const flagPath = join(dir, '.anatoly', 'embeddings-ready.json');
    expect(existsSync(flagPath)).toBe(true);
    const flag = JSON.parse(readFileSync(flagPath, 'utf-8')) as { backend?: string };
    expect(flag.backend).toBe('external');
  });

  it('external tier YAML loads without throwing', async () => {
    process.env.MISTRAL_API_KEY = 'dummy';
    process.env.OPENROUTER_API_KEY = 'dummy';
    await writeFirstRunConfig(dir, { tier: 'external' });
    const { loadConfig } = await import('../utils/config-loader.js');
    expect(() => loadConfig(dir)).not.toThrow();
    delete process.env.MISTRAL_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  // -------------------------------------------------------------------------
  // Annotated YAML — every optional section is present (commented)
  // -------------------------------------------------------------------------

  it('renders an active scan block with respect_gitignore: true', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    // Active (uncommented) section — globs are derived per-project at write
    // time, not stuffed in a commented defaults block.
    expect(content).toMatch(/^scan:$/m);
    expect(content).toContain('respect_gitignore: true');
    expect(content).toContain('  include:');
    expect(content).toContain('  exclude:');
  });

  it('renders commented section for coverage with default command', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toMatch(/^# coverage:$/m);
    expect(content).toContain('#   command: npx vitest run --coverage.reporter=json');
  });

  it('renders commented section for runtime with all sub-sections', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toMatch(/^# runtime:$/m);
    expect(content).toContain('#   concurrency: 8');
    expect(content).toContain('#   timeout_per_file: 600');
    expect(content).toContain('#   agents:');
    expect(content).toContain('#     max_turns: 30');
    expect(content).toContain('#   rag:');
    expect(content).toContain('#     code_share: 0.6');
    expect(content).toContain('#   logging:');
    expect(content).toContain('#     level: warn');
  });

  it('renders commented section for notifications.telegram', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toMatch(/^# notifications:$/m);
    expect(content).toContain('#   telegram:');
    expect(content).toContain('#     bot_token_env: ANATOLY_TELEGRAM_BOT_TOKEN');
  });

  it('renders commented section for badge with default link', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toMatch(/^# badge:$/m);
    expect(content).toContain('#   link: https://github.com/r-via/anatoly');
  });

  it('renders commented section for search', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toMatch(/^# search:$/m);
  });

  it('renders inactive providers (google, advanced, external) as commented blocks for lite tier', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    // local-lite is active (uncommented)
    expect(content).toContain('  local-lite:');
    expect(content).toMatch(/^  local-lite:$/m);
    // local-advanced, mistral, openrouter, google are commented
    expect(content).toContain('  # local-advanced:');
    expect(content).toContain('  # mistral:');
    expect(content).toContain('  # openrouter:');
    expect(content).toContain('  # google:');
  });

  it('keeps local-lite active and comments other providers for advanced tier', async () => {
    await writeFirstRunConfig(dir, { tier: 'advanced' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toContain('  local-advanced:');
    expect(content).toMatch(/^  local-lite:$/m);
    expect(content).toContain('  # mistral:');
  });

  it('keeps local-lite active and comments other inactive providers for external tier', async () => {
    await writeFirstRunConfig(dir, { tier: 'external' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toContain('  mistral:');
    expect(content).toContain('  openrouter:');
    expect(content).toMatch(/^  local-lite:$/m);
    expect(content).toContain('  # local-advanced:');
  });

  it('includes per-axis override examples as commented hints', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toContain('# Per-axis override example');
    expect(content).toContain('#   correction:');
    expect(content).toContain('#     model: anthropic/claude-opus-4-6');
    expect(content).toContain('# Documentation extras');
    expect(content).toContain('#     docs_path: docs');
    expect(content).toContain('#     module_mapping:');
  });

  it('full annotated YAML still parses to a valid v3 (commented sections are inert)', async () => {
    await writeFirstRunConfig(dir, { tier: 'lite' });
    const { loadConfig } = await import('../utils/config-loader.js');
    const config = loadConfig(dir);
    expect(config).toBeDefined();
    // Commented sections do NOT take effect — the config still uses defaults
    // for them (e.g. notifications stays absent, scan uses schema defaults).
    expect(config.notifications).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runEndOfSetupPrompt tests
// ---------------------------------------------------------------------------

describe('runEndOfSetupPrompt', () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'end-of-setup-'));
    selectMock.mockReset();
    noteMock.mockReset();
    tryOpenFileMock.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  function baseSetupOpts(overrides?: Partial<EndOfSetupOptions>): EndOfSetupOptions {
    return {
      isTTY: true,
      defaultsSettings: false,
      projectRoot: dir,
      ...overrides,
    };
  }

  // AC: Given --defaults-settings set, Then auto-proceed (no prompt)
  it('auto-proceeds when defaultsSettings is true', async () => {
    await runEndOfSetupPrompt(baseSetupOpts({ defaultsSettings: true }));
    expect(selectMock).not.toHaveBeenCalled();
  });

  // AC: Given non-TTY, Then auto-proceed (no prompt)
  it('auto-proceeds when isTTY is false', async () => {
    await runEndOfSetupPrompt(baseSetupOpts({ isTTY: false }));
    expect(selectMock).not.toHaveBeenCalled();
  });

  // AC: Given "Proceed with audit" is chosen, Then run continues normally
  it('returns normally when proceed is chosen', async () => {
    selectMock.mockResolvedValueOnce('proceed');
    await runEndOfSetupPrompt(baseSetupOpts());
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // AC: p.select is called with 3 options: proceed (first), open-config, quit
  it('shows 3 options with proceed as first', async () => {
    selectMock.mockResolvedValueOnce('proceed');
    await runEndOfSetupPrompt(baseSetupOpts());

    const callArgs = selectMock.mock.calls[0]![0]!;
    expect(callArgs.options).toHaveLength(3);
    expect(callArgs.options[0]!.value).toBe('proceed');
    expect(callArgs.options[1]!.value).toBe('open-config');
    expect(callArgs.options[2]!.value).toBe('quit');
  });

  // AC: Given "Open .anatoly.yml" and openFile succeeds, Then message + exit 0
  it('opens config in editor and exits when tryOpenFile succeeds', async () => {
    selectMock.mockResolvedValueOnce('open-config');
    tryOpenFileMock.mockResolvedValueOnce(true);

    await expect(runEndOfSetupPrompt(baseSetupOpts())).rejects.toThrow('process.exit');

    expect(tryOpenFileMock).toHaveBeenCalledWith(join(dir, '.anatoly.yml'));
    expect(exitSpy).toHaveBeenCalledWith(0);
    // Verify message shown
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Opened in editor'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('run anatoly run again when ready'));
  });

  // AC: Given "Open .anatoly.yml" and openFile fails, Then path + YAML content printed + exit 0
  it('prints path and YAML content when tryOpenFile fails', async () => {
    // Write a config file so it can be read
    const { writeFileSync: realWriteFileSync } = await import('node:fs');
    realWriteFileSync(join(dir, '.anatoly.yml'), 'providers:\n  anthropic:\n    mode: subscription\n', 'utf-8');

    selectMock.mockResolvedValueOnce('open-config');
    tryOpenFileMock.mockResolvedValueOnce(false);

    await expect(runEndOfSetupPrompt(baseSetupOpts())).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    // Should print the path
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('.anatoly.yml'));
    // Should print YAML content
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mode: subscription'));
  });

  // AC: Given "Quit" is chosen, Then message + exit 0
  it('shows message and exits when quit is chosen', async () => {
    selectMock.mockResolvedValueOnce('quit');

    await expect(runEndOfSetupPrompt(baseSetupOpts())).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration saved to .anatoly.yml'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('run anatoly run when ready'));
  });

  // AC: Given Ctrl+C, Then exit 0 (equivalent to Quit)
  it('exits on Ctrl+C (cancel)', async () => {
    selectMock.mockResolvedValueOnce(Symbol('cancel'));

    await expect(runEndOfSetupPrompt(baseSetupOpts())).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
