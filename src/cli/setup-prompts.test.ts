// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HardwareProfile } from '../rag/hardware-detect.js';
import { runFirstRunWizard, runLitePrefetch, runGgufPrefetch, runSetupEmbeddingsSubprocess, writeFirstRunConfig, runEndOfSetupPrompt, type WizardOptions, type EndOfSetupOptions, type ExternalAxisConfig } from './setup-prompts.js';

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

// Mock child_process.spawnSync for setup-embeddings subprocess tests
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
// External wizard flow tests (Story 50.6)
// ---------------------------------------------------------------------------

describe('runFirstRunWizard — external tier (Story 50.6)', () => {
  // Save and clear all known external-provider API keys before each test, then
  // set the ones the tests under this suite expect (voyage + openrouter). The
  // wizard now hard-aborts when a chosen provider's API key is missing, so the
  // env must be primed before exercising the external flow.
  const PROVIDER_KEYS = ['VOYAGE_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'COHERE_API_KEY', 'MISTRAL_API_KEY'];
  const savedKeys: Record<string, string | undefined> = {};

  beforeEach(() => {
    selectMock.mockReset();
    textMock.mockReset();
    noteMock.mockReset();
    cancelMock.mockReset();
    for (const k of PROVIDER_KEYS) {
      savedKeys[k] = process.env[k];
      delete process.env[k];
    }
    process.env.VOYAGE_API_KEY = 'test-voyage-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    for (const k of PROVIDER_KEYS) {
      if (savedKeys[k] !== undefined) process.env[k] = savedKeys[k];
      else delete process.env[k];
    }
  });

  // Helper: mock the full external flow (voyage code, same NLP, full-run mode)
  function mockExternalVoyageSame() {
    selectMock
      .mockResolvedValueOnce('external')     // tier
      .mockResolvedValueOnce('voyage')        // code provider
      .mockResolvedValueOnce('same')          // NLP provider = same as code
      .mockResolvedValueOnce('full-run');     // mode
    textMock
      .mockResolvedValueOnce('voyage-code-3'); // code model
  }

  // Helper: mock the full external flow (voyage code, openrouter NLP, full-run mode)
  function mockExternalVoyageQwen() {
    selectMock
      .mockResolvedValueOnce('external')     // tier
      .mockResolvedValueOnce('voyage')        // code provider
      .mockResolvedValueOnce('openrouter')    // NLP provider
      .mockResolvedValueOnce('full-run');     // mode
    textMock
      .mockResolvedValueOnce('voyage-code-3')             // code model
      .mockResolvedValueOnce('qwen/qwen3-embedding-8b');  // NLP model
  }

  // AC: tier options always contain External
  it('includes External tier option on incapable hardware', async () => {
    selectMock.mockResolvedValueOnce('lite');
    selectMock.mockResolvedValueOnce('quick-win');

    await runFirstRunWizard(baseOpts({ hardware: incapableHardware }));

    const tierCall = selectMock.mock.calls[0]![0];
    const externalOpt = tierCall.options.find((o: { value: string }) => o.value === 'external');
    expect(externalOpt).toBeDefined();
    expect(externalOpt!.label).toContain('External');
  });

  it('includes External tier option on capable hardware', async () => {
    selectMock.mockResolvedValueOnce('lite');
    selectMock.mockResolvedValueOnce('quick-win');

    await runFirstRunWizard(baseOpts({ hardware: capableHardware }));

    const tierCall = selectMock.mock.calls[0]![0];
    const externalOpt = tierCall.options.find((o: { value: string }) => o.value === 'external');
    expect(externalOpt).toBeDefined();
  });

  // AC: non-interactive returns lite, not external
  it('returns lite/full-run when defaultsSettings is true (no external auto)', async () => {
    const result = await runFirstRunWizard(baseOpts({ defaultsSettings: true }));
    expect(result).toEqual({ tier: 'lite', mode: 'full-run' });
    expect(result.external).toBeUndefined();
  });

  // AC: code provider select shows registry providers + Custom
  it('shows code provider select with registry providers and Custom', async () => {
    mockExternalVoyageSame();
    await runFirstRunWizard(baseOpts());

    // Second select call = code provider
    const codeProviderCall = selectMock.mock.calls[1]![0];
    const providerValues = codeProviderCall.options.map((o: { value: string }) => o.value);
    expect(providerValues).toContain('openai');
    expect(providerValues).toContain('voyage');
    expect(providerValues).toContain('openrouter');
    expect(providerValues).toContain('cohere');
    expect(providerValues).toContain('mistral');
    expect(providerValues).toContain('custom');
    // anatoly-local should NOT be in external providers
    expect(providerValues).not.toContain('anatoly-local');
  });

  // AC: voyage is pre-selected (first option) for code
  it('lists voyage as first code provider option', async () => {
    mockExternalVoyageSame();
    await runFirstRunWizard(baseOpts());

    const codeProviderCall = selectMock.mock.calls[1]![0];
    expect(codeProviderCall.options[0]!.value).toBe('voyage');
  });

  // AC: each code provider option shows default_code_model as hint
  it('shows default_code_model as hint for each code provider', async () => {
    mockExternalVoyageSame();
    await runFirstRunWizard(baseOpts());

    const codeProviderCall = selectMock.mock.calls[1]![0];
    const voyageOpt = codeProviderCall.options.find((o) => o.value === 'voyage');
    expect(voyageOpt!.hint).toBe('voyage-code-3');
    const openaiOpt = codeProviderCall.options.find((o) => o.value === 'openai');
    expect(openaiOpt!.hint).toBe('text-embedding-3-large');
  });

  // AC: code model text prompt pre-filled with default
  it('prompts for code model with default pre-filled', async () => {
    mockExternalVoyageSame();
    await runFirstRunWizard(baseOpts());

    expect(textMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: 'voyage-code-3' }),
    );
  });

  // AC: NLP provider select has "Same as code" as first option
  it('shows "Same as code" as first NLP provider option', async () => {
    mockExternalVoyageSame();
    await runFirstRunWizard(baseOpts());

    // Third select call = NLP provider
    const nlpProviderCall = selectMock.mock.calls[2]![0];
    expect(nlpProviderCall.options[0]!.value).toBe('same');
    expect(nlpProviderCall.options[0]!.label).toContain('Voyage');
  });

  // AC: "Same as code" duplicates code config to NLP
  it('duplicates code config to NLP when "Same as code" is chosen', async () => {
    mockExternalVoyageSame();
    const result = await runFirstRunWizard(baseOpts());

    expect(result.tier).toBe('external');
    expect(result.external).toBeDefined();
    expect(result.external!.code).toEqual({ provider: 'voyage', model: 'voyage-code-3', env_key: 'VOYAGE_API_KEY' });
    expect(result.external!.nlp).toEqual(result.external!.code);
  });

  // AC: "Same as code" → no NLP model prompt
  it('skips NLP model prompt when "Same as code" is chosen', async () => {
    mockExternalVoyageSame();
    await runFirstRunWizard(baseOpts());

    // Only one text call (code model), not two
    expect(textMock).toHaveBeenCalledTimes(1);
  });

  // AC: distinct NLP provider → NLP model prompt shown
  it('prompts for NLP model when distinct provider is chosen', async () => {
    mockExternalVoyageQwen();
    await runFirstRunWizard(baseOpts());

    // Two text calls: code model + NLP model
    expect(textMock).toHaveBeenCalledTimes(2);
    expect(textMock).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ initialValue: 'qwen/qwen3-embedding-8b' }),
    );
  });

  // AC: WizardResult shape for external with distinct providers
  it('returns correct WizardResult for distinct code/NLP providers', async () => {
    mockExternalVoyageQwen();
    const result = await runFirstRunWizard(baseOpts());

    expect(result.tier).toBe('external');
    expect(result.mode).toBe('full-run');
    expect(result.external).toEqual({
      code: { provider: 'voyage', model: 'voyage-code-3', env_key: 'VOYAGE_API_KEY' },
      nlp: { provider: 'openrouter', model: 'qwen/qwen3-embedding-8b', env_key: 'OPENROUTER_API_KEY' },
    });
  });

  // AC: WizardResult.external is undefined for lite tier
  it('has undefined external for lite tier', async () => {
    selectMock.mockResolvedValueOnce('lite');
    selectMock.mockResolvedValueOnce('full-run');
    const result = await runFirstRunWizard(baseOpts());
    expect(result.external).toBeUndefined();
  });

  // AC: env key detection — key present
  it('shows ✓ note when env key is present', async () => {
    const origKey = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = 'test-key';
    try {
      mockExternalVoyageSame();
      await runFirstRunWizard(baseOpts());

      const detected = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('✓ VOYAGE_API_KEY detected'),
      );
      expect(detected).toBeDefined();
    } finally {
      if (origKey !== undefined) process.env.VOYAGE_API_KEY = origKey;
      else delete process.env.VOYAGE_API_KEY;
    }
  });

  // The wizard now hard-aborts when the chosen provider's API key is missing,
  // rather than emitting a warning and continuing — writing .anatoly.yml with
  // a provider whose key isn't exported only defers a runtime failure.
  it('aborts the wizard with exit code 2 when env key is absent', async () => {
    delete process.env.VOYAGE_API_KEY;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    try {
      mockExternalVoyageSame();
      await expect(runFirstRunWizard(baseOpts())).rejects.toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(cancelMock).toHaveBeenCalledWith(expect.stringContaining('VOYAGE_API_KEY'));
    } finally {
      exitSpy.mockRestore();
    }
  });

  // AC: Custom provider flow — 4 text prompts
  it('prompts 4 text inputs for custom code provider', async () => {
    process.env.HF_INTERNAL_TOKEN = 'test-hf-token';
    selectMock
      .mockResolvedValueOnce('external')     // tier
      .mockResolvedValueOnce('custom')        // code provider = custom
      .mockResolvedValueOnce('same')          // NLP = same as code
      .mockResolvedValueOnce('full-run');     // mode
    textMock
      .mockResolvedValueOnce('hf-internal')   // provider name
      .mockResolvedValueOnce('https://abc.endpoints.huggingface.cloud/v1') // base_url
      .mockResolvedValueOnce('HF_INTERNAL_TOKEN') // env_key
      .mockResolvedValueOnce('nomic-embed-code');  // model

    const result = await runFirstRunWizard(baseOpts());

    expect(result.external!.code).toEqual({
      provider: 'hf-internal',
      model: 'nomic-embed-code',
      base_url: 'https://abc.endpoints.huggingface.cloud/v1',
      env_key: 'HF_INTERNAL_TOKEN',
    });
    // Same as code → NLP is duplicated
    expect(result.external!.nlp).toEqual(result.external!.code);
    // 4 text prompts for custom
    expect(textMock).toHaveBeenCalledTimes(4);
  });

  // AC: Ctrl+C in code provider select → process.exit(0)
  it('exits on Ctrl+C during code provider select', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    selectMock
      .mockResolvedValueOnce('external')                          // tier
      .mockResolvedValueOnce(Symbol('cancel') as unknown as string); // code provider cancel

    await expect(runFirstRunWizard(baseOpts())).rejects.toThrow('process.exit');

    expect(cancelMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  // AC: Ctrl+C in code model text → process.exit(0)
  it('exits on Ctrl+C during code model text input', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    selectMock
      .mockResolvedValueOnce('external')     // tier
      .mockResolvedValueOnce('voyage');       // code provider
    textMock
      .mockResolvedValueOnce(Symbol('cancel') as unknown as string); // code model cancel

    await expect(runFirstRunWizard(baseOpts())).rejects.toThrow('process.exit');

    expect(cancelMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  // AC: Ctrl+C in NLP provider select → process.exit(0)
  it('exits on Ctrl+C during NLP provider select', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    selectMock
      .mockResolvedValueOnce('external')                          // tier
      .mockResolvedValueOnce('voyage')                            // code provider
      .mockResolvedValueOnce(Symbol('cancel') as unknown as string); // NLP provider cancel
    textMock
      .mockResolvedValueOnce('voyage-code-3');                    // code model

    await expect(runFirstRunWizard(baseOpts())).rejects.toThrow('process.exit');

    expect(cancelMock).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  // AC: --quick-win with external tier → mode is quick-win
  it('returns quick-win mode when --quick-win flag is set', async () => {
    selectMock
      .mockResolvedValueOnce('external')     // tier
      .mockResolvedValueOnce('voyage')        // code provider
      .mockResolvedValueOnce('same');         // NLP provider = same
    textMock
      .mockResolvedValueOnce('voyage-code-3'); // code model

    const result = await runFirstRunWizard(baseOpts({ quickWin: true }));

    expect(result.tier).toBe('external');
    expect(result.mode).toBe('quick-win');
    // Mode prompt should not be called (3 selects: tier + code provider + NLP provider)
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  // AC: NLP select shows openrouter (Qwen3-8B) as recommended (after "Same as code")
  it('lists openrouter as first distinct NLP provider option (after Same)', async () => {
    mockExternalVoyageSame();
    await runFirstRunWizard(baseOpts());

    const nlpProviderCall = selectMock.mock.calls[2]![0];
    // Index 0 = "Same as code", Index 1 = openrouter (recommended for NLP — routes Qwen3-8B at 4096d)
    expect(nlpProviderCall.options[1]!.value).toBe('openrouter');
  });

  // AC: NLP provider options show default_nlp_model as hint
  it('shows default_nlp_model as hint for NLP provider options', async () => {
    mockExternalVoyageSame();
    await runFirstRunWizard(baseOpts());

    const nlpProviderCall = selectMock.mock.calls[2]![0];
    const voyageOpt = nlpProviderCall.options.find((o) => o.value === 'voyage');
    expect(voyageOpt!.hint).toBe('voyage-3-large');
    const openrouterOpt = nlpProviderCall.options.find((o) => o.value === 'openrouter');
    expect(openrouterOpt!.hint).toBe('qwen/qwen3-embedding-8b');
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
// runSetupEmbeddingsSubprocess tests
// ---------------------------------------------------------------------------

describe('runSetupEmbeddingsSubprocess', () => {
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

  // AC: Given story 48.3 has downloaded GGUF models, When runSetupEmbeddingsSubprocess() is called,
  // Then spawnSync('node', ['anatoly', 'setup-embeddings'], { stdio: 'inherit' }) is executed
  it('spawns the setup-embeddings subprocess with stdio inherit', () => {
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined });

    const result = runSetupEmbeddingsSubprocess('/tmp/project');

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/usr/local/bin/anatoly', 'setup-embeddings'],
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

    const result = runSetupEmbeddingsSubprocess('/tmp/project');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  // AC: Given subprocess exits with non-zero code, When the parent resumes,
  // Then { ok: false, exitCode: <code> }
  it('returns ok false when subprocess exits with non-zero code', () => {
    spawnSyncMock.mockReturnValue({ status: 1, error: undefined });

    const result = runSetupEmbeddingsSubprocess('/tmp/project');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  // AC: Given subprocess returns null status (killed by signal), Then ok false, exitCode -1
  it('returns ok false with exitCode -1 when status is null (signal kill)', () => {
    spawnSyncMock.mockReturnValue({ status: null, error: new Error('SIGTERM') });

    const result = runSetupEmbeddingsSubprocess('/tmp/project');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
  });

  // AC: Given process.argv[0] is undefined, When runSetupEmbeddingsSubprocess() tries to spawn,
  // Then an AnatolyError is thrown
  it('throws AnatolyError when process.argv[0] is undefined', () => {
    process.argv[0] = undefined as unknown as string;

    expect(() => runSetupEmbeddingsSubprocess('/tmp/project'))
      .toThrow(/Cannot resolve anatoly CLI binary path/);
  });

  // AC: Given process.argv[1] is undefined, When runSetupEmbeddingsSubprocess() tries to spawn,
  // Then an AnatolyError is thrown
  it('throws AnatolyError when process.argv[1] is undefined', () => {
    process.argv[1] = undefined as unknown as string;

    expect(() => runSetupEmbeddingsSubprocess('/tmp/project'))
      .toThrow(/Cannot resolve anatoly CLI binary path/);
  });

  // AC: passes ANATOLY_PROJECT_ROOT in env
  it('passes ANATOLY_PROJECT_ROOT as the projectRoot argument', () => {
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined });

    runSetupEmbeddingsSubprocess('/home/user/myproject');

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

  // AC: Given the first-run wizard completed, When writeFirstRunConfig(projectRoot) is called,
  // Then a .anatoly.yml is written with correct providers, models, axes, and rag
  it('writes .anatoly.yml with subscription mode when no API key detected', () => {
    writeFirstRunConfig(dir);

    const filePath = join(dir, '.anatoly.yml');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('providers:');
    expect(content).toContain('mode: subscription');
    expect(content).toContain('models:');
    expect(content).toContain("quality: anthropic/claude-sonnet-4-6");
    expect(content).toContain("fast: anthropic/claude-haiku-4-5-20251001");
    expect(content).toContain("deliberation: anthropic/claude-opus-4-6");
  });

  // AC: Header comment
  it('includes header comment at top of file', () => {
    writeFirstRunConfig(dir);

    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content.startsWith('# Anatoly configuration')).toBe(true);
    expect(content).toContain('generated by first-run wizard');
    expect(content).toContain('Edit freely');
  });

  // AC: All axes enabled
  it('writes all 7 axes as enabled', () => {
    writeFirstRunConfig(dir);

    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toContain('axes:');
    for (const axis of ['utility', 'duplication', 'correction', 'overengineering', 'tests', 'best_practices', 'documentation']) {
      expect(content).toContain(`${axis}:`);
    }
    // All should have enabled: true
    expect(content).toContain('enabled: true');
  });

  // AC: rag.code_model = 'auto'
  it('sets rag.code_model to auto', () => {
    writeFirstRunConfig(dir);

    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toContain('rag:');
    expect(content).toContain("code_model: auto");
  });

  // AC: Given ANTHROPIC_API_KEY is detected, Then providers.anthropic.mode is 'api'
  it('sets provider mode to api when ANTHROPIC_API_KEY is in env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

    writeFirstRunConfig(dir);

    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    expect(content).toContain('mode: api');
    expect(content).not.toContain('mode: subscription');
  });

  // AC: The generated YAML can be parsed back by loadConfig
  it('generates valid YAML that can be loaded by js-yaml', async () => {
    writeFirstRunConfig(dir);

    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    // Use dynamic import to avoid issues with the yaml mock
    const yaml = await import('js-yaml');
    const parsed = yaml.load(content) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(parsed.providers).toBeDefined();
    expect(parsed.models).toBeDefined();
    expect(parsed.axes).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Story 50.6: writeFirstRunConfig with external embedding config
  // -------------------------------------------------------------------------

  // AC: external tier → rag.embedding section written with code + nlp
  it('writes rag.embedding section for external tier (Story 50.6)', async () => {
    writeFirstRunConfig(dir, {
      external: {
        code: { provider: 'voyage', model: 'voyage-code-3' },
        nlp: { provider: 'openrouter', model: 'qwen/qwen3-embedding-8b' },
      },
    });

    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    const yaml = await import('js-yaml');
    const parsed = yaml.load(content) as { rag: { embedding: { code: ExternalAxisConfig; nlp: ExternalAxisConfig } } };
    expect(parsed.rag.embedding).toBeDefined();
    expect(parsed.rag.embedding.code.provider).toBe('voyage');
    expect(parsed.rag.embedding.code.model).toBe('voyage-code-3');
    expect(parsed.rag.embedding.nlp.provider).toBe('openrouter');
    expect(parsed.rag.embedding.nlp.model).toBe('qwen/qwen3-embedding-8b');
  });

  // AC: "Same as code" → both sections written explicitly
  it('writes both code and nlp sections explicitly for "Same as code" (Story 50.6)', async () => {
    writeFirstRunConfig(dir, {
      external: {
        code: { provider: 'openai', model: 'text-embedding-3-large' },
        nlp: { provider: 'openai', model: 'text-embedding-3-large' },
      },
    });

    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    const yaml = await import('js-yaml');
    const parsed = yaml.load(content) as { rag: { embedding: { code: ExternalAxisConfig; nlp: ExternalAxisConfig } } };
    expect(parsed.rag.embedding.code).toEqual({ provider: 'openai', model: 'text-embedding-3-large' });
    expect(parsed.rag.embedding.nlp).toEqual({ provider: 'openai', model: 'text-embedding-3-large' });
  });

  // AC: custom provider → base_url and env_key written
  it('writes base_url and env_key for custom providers (Story 50.6)', async () => {
    writeFirstRunConfig(dir, {
      external: {
        code: {
          provider: 'hf-internal',
          model: 'nomic-embed-code',
          base_url: 'https://abc.endpoints.huggingface.cloud/v1',
          env_key: 'HF_INTERNAL_TOKEN',
        },
        nlp: {
          provider: 'hf-internal',
          model: 'nomic-embed-code',
          base_url: 'https://abc.endpoints.huggingface.cloud/v1',
          env_key: 'HF_INTERNAL_TOKEN',
        },
      },
    });

    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    const yaml = await import('js-yaml');
    const parsed = yaml.load(content) as { rag: { embedding: { code: ExternalAxisConfig; nlp: ExternalAxisConfig } } };
    expect(parsed.rag.embedding.code.base_url).toBe('https://abc.endpoints.huggingface.cloud/v1');
    expect(parsed.rag.embedding.code.env_key).toBe('HF_INTERNAL_TOKEN');
  });

  // AC: lite tier → no rag.embedding section
  it('does not write rag.embedding section for lite tier (Story 50.6)', async () => {
    writeFirstRunConfig(dir);

    const content = readFileSync(join(dir, '.anatoly.yml'), 'utf-8');
    const yaml = await import('js-yaml');
    const parsed = yaml.load(content) as { rag: { embedding?: unknown } };
    expect(parsed.rag.embedding).toBeUndefined();
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
