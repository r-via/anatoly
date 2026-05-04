// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HardwareProfile } from '../rag/hardware-detect.js';
import { runFirstRunWizard, runLitePrefetch, runGgufPrefetch, runSetupEmbeddingsSubprocess, writeFirstRunConfig, runEndOfSetupPrompt, type WizardOptions, type WizardResult, type EndOfSetupOptions } from './setup-prompts.js';

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

const selectMock = vi.fn<(opts: { message: string; options: Array<{ value: string }> }) => Promise<string>>();
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
  select: (opts: { message: string; options: Array<{ value: string }> }) => selectMock(opts),
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

  // AC: Hardware without GPU → only Default option shown, note explaining why
  describe('incapable hardware (no CUDA GPU)', () => {
    it('shows only Default option for tier prompt', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: incapableHardware }));

      const tierCall = selectMock.mock.calls[0]![0];
      expect(tierCall.options).toHaveLength(1);
      expect(tierCall.options[0]!.value).toBe('lite');
    });

    it('shows a note explaining why advanced is unavailable', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: incapableHardware }));

      expect(noteMock).toHaveBeenCalledWith(
        expect.stringContaining('Advanced not available'),
        expect.any(String),
      );
    });
  });

  // AC: Hardware with low VRAM → same as incapable
  describe('low VRAM hardware (CUDA but < 12 GB)', () => {
    it('shows only Default option for tier prompt', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: lowVramHardware }));

      const tierCall = selectMock.mock.calls[0]![0];
      expect(tierCall.options).toHaveLength(1);
      expect(tierCall.options[0]!.value).toBe('lite');
    });
  });

  // AC: Hardware with GPU CUDA + ≥ 12 GB VRAM → both options shown
  describe('capable hardware (CUDA GPU + ≥ 12 GB VRAM)', () => {
    it('shows both Default and Advanced options for tier prompt', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware }));

      const tierCall = selectMock.mock.calls[0]![0];
      expect(tierCall.options).toHaveLength(2);
      expect(tierCall.options[0]!.value).toBe('lite');
      expect(tierCall.options[1]!.value).toBe('advanced');
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

  // AC: Privacy/transparency (Story 49.5 mentions this but the note is part of tier prompt rendering)
  describe('transparency notice', () => {
    it('includes a privacy/transparency line in the tier prompt', async () => {
      selectMock.mockResolvedValueOnce('lite');
      selectMock.mockResolvedValueOnce('quick-win');

      await runFirstRunWizard(baseOpts({ hardware: capableHardware }));

      // Check that note contains transparency info
      const transparencyNote = noteMock.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('No telemetry'),
      );
      expect(transparencyNote).toBeDefined();
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
