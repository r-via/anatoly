import { describe, it, expect } from 'vitest';
import { createProgram } from './cli.js';

describe('CLI program', () => {
  const program = createProgram();

  it('should have the correct name', () => {
    expect(program.name()).toBe('anatoly');
  });

  it('should have the correct version', () => {
    expect(program.version()).toBe('0.1.0');
  });

  it('should register all 9 subcommands', () => {
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
        'clean-logs',
        'reset',
      ]),
    );
    expect(commandNames).toHaveLength(9);
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
      ]),
    );
  });
});
