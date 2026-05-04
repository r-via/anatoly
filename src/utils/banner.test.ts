// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { printSetupToAuditTransition } from './banner.js';

describe('printSetupToAuditTransition', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  // AC1: separator + banner with "The weight is good !" + trailing blank line
  it('prints separator, banner with motd, and trailing blank line', () => {
    printSetupToAuditTransition({ plain: false });

    // First line should be a separator with box-drawing chars
    expect(logged[0]).toMatch(/─{10,}/);

    // Banner should contain the MOTD
    const bannerText = logged.join('\n');
    expect(bannerText).toContain('The weight is good !');
    expect(bannerText).toContain('Starting audit');

    // Should end with a trailing blank line
    expect(logged[logged.length - 1]).toBe('');
  });

  // AC3: --plain → simple text-only transition
  it('prints simple text transition in plain mode', () => {
    printSetupToAuditTransition({ plain: true });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe('--- starting audit ---');
  });

  // AC2: --defaults-settings still gets the visual transition (not plain unless --plain)
  it('prints full visual transition even in defaults mode (non-plain)', () => {
    printSetupToAuditTransition({ plain: false });

    const bannerText = logged.join('\n');
    expect(bannerText).toContain('The weight is good !');
    // Should NOT be the plain fallback
    expect(logged[0]).not.toBe('--- starting audit ---');
  });

  // AC4: reuses printBanner (verified by checking ASCII art appears)
  it('contains ASCII art from printBanner', () => {
    printSetupToAuditTransition({ plain: false });

    const bannerText = logged.join('\n');
    // The ASCII art from MOTD_LINES contains these distinctive patterns
    expect(bannerText).toContain('___');
    expect(bannerText).toContain('====');
  });
});
