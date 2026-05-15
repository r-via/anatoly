// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerRunsCommand } from './runs.js';
import { RUNS_REMOVE_EMPTY_CMD } from '../utils/run-id.js';

/**
 * Regression guard: the empty-runs warning emitted by `anatoly run`
 * (run.ts) tells the user to run RUNS_REMOVE_EMPTY_CMD. That string used
 * to read `anatoly audit remove --empty`, but no `audit` command exists —
 * the command group is `runs`. These tests pin the hint to the command
 * path that is actually registered, so the two can never drift again.
 */
describe('runs remove --empty — cleanup hint matches registered command', () => {
  function buildProgram(): Command {
    const program = new Command().name('anatoly');
    registerRunsCommand(program);
    return program;
  }

  it('registers `runs remove` with an --empty option', () => {
    const runs = buildProgram().commands.find((c) => c.name() === 'runs');
    expect(runs, 'a top-level `runs` command should be registered').toBeDefined();

    const remove = runs!.commands.find((c) => c.name() === 'remove');
    expect(remove, '`runs remove` subcommand should be registered').toBeDefined();

    const hasEmpty = remove!.options.some((o) => o.long === '--empty');
    expect(hasEmpty, '`runs remove` should accept --empty').toBe(true);
  });

  it('RUNS_REMOVE_EMPTY_CMD is the actual `<prog> runs remove --empty` path', () => {
    const program = buildProgram();
    const runs = program.commands.find((c) => c.name() === 'runs')!;
    const remove = runs.commands.find((c) => c.name() === 'remove')!;

    const reconstructed = `${program.name()} ${runs.name()} ${remove.name()} --empty`;
    expect(RUNS_REMOVE_EMPTY_CMD).toBe(reconstructed);
  });

  it('does not point at a non-existent `audit` command (the original bug)', () => {
    expect(RUNS_REMOVE_EMPTY_CMD).not.toContain('audit');

    const program = buildProgram();
    const audit = program.commands.find((c) => c.name() === 'audit');
    expect(audit, 'there is no top-level `audit` command').toBeUndefined();
  });
});
