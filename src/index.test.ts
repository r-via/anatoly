// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { createProgram } from './cli.js';

describe('CLI program', () => {
  const program = createProgram();

  it('should have the correct name', () => {
    expect(program.name()).toBe('anatoly');
  });

  it('should have the correct version', () => {
    expect(program.version()).toBe('0.0.0-dev');
  });

  it('should register all subcommands', () => {
    const commandNames = program.commands.map((cmd) => cmd.name());
    expect(commandNames).toEqual(
      expect.arrayContaining([
        'scan',
        'estimate',
        'review',
        'report',
        'run',
        'watch',
        'status',
        'clean',
        'reset',
        'rag-status',
        'hook',
        'setup-embeddings',
        'init',
        'docs',
        'providers',
      ]),
    );
    expect(commandNames).toHaveLength(15);
  });

  it('should register all global options', () => {
    const optionFlags = program.options.map((opt) => opt.long);
    expect(optionFlags).toEqual(
      expect.arrayContaining([
        '--config',
        '--verbose',
        '--no-cache',
        '--file',
        '--plain',
        '--no-color',
        '--open',
      ]),
    );
  });
});
