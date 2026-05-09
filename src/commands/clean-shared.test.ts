// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerCleanSharedCommand } from './clean-shared.js';

describe('registerCleanSharedCommand', () => {
  it('registers a "shared" subcommand on the parent command', () => {
    const parent = new Command('clean');
    registerCleanSharedCommand(parent);

    const sub = parent.commands.find((c) => c.name() === 'shared');
    expect(sub).toBeDefined();
    expect(sub!.description()).toContain('shared cache');
  });

  it('has a --yes / -y option', () => {
    const parent = new Command('clean');
    registerCleanSharedCommand(parent);

    const sub = parent.commands.find((c) => c.name() === 'shared')!;
    const yesOpt = sub.options.find((o) => o.long === '--yes');
    expect(yesOpt).toBeDefined();
    expect(yesOpt!.short).toBe('-y');
  });
});
