// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HardwareProfile } from '../rag/hardware-detect.js';
import { runFirstRunWizard, type WizardOptions, type WizardResult } from './setup-prompts.js';

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

vi.mock('@clack/prompts', () => ({
  select: (opts: { message: string; options: Array<{ value: string }> }) => selectMock(opts),
  note: (...args: unknown[]) => noteMock(...args),
  cancel: (...args: unknown[]) => cancelMock(...args),
  isCancel: (val: unknown) => typeof val === 'symbol',
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFirstRunWizard', () => {
  beforeEach(() => {
    selectMock.mockReset();
    noteMock.mockReset();
    cancelMock.mockReset();
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
});
