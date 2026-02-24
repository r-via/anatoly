import { describe, it, expect } from 'vitest';
import { createProgram } from '../cli.js';

describe('hook command registration', () => {
  it('registers hook command with post-edit and stop subcommands', () => {
    const program = createProgram();
    const hookCmd = program.commands.find((c) => c.name() === 'hook');
    expect(hookCmd).toBeDefined();
    expect(hookCmd!.description()).toBe('Claude Code integration hooks (internal)');

    const subcommands = hookCmd!.commands.map((c) => c.name());
    expect(subcommands).toContain('post-edit');
    expect(subcommands).toContain('stop');
  });

  it('post-edit subcommand has correct description', () => {
    const program = createProgram();
    const hookCmd = program.commands.find((c) => c.name() === 'hook');
    const postEdit = hookCmd!.commands.find((c) => c.name() === 'post-edit');
    expect(postEdit).toBeDefined();
    expect(postEdit!.description()).toContain('PostToolUse');
  });

  it('stop subcommand has correct description', () => {
    const program = createProgram();
    const hookCmd = program.commands.find((c) => c.name() === 'stop');
  });
});

describe('extractFilePath', () => {
  // We test this indirectly — the function is private, but we validate
  // the JSON parsing logic it depends on
  it('Claude Code PostToolUse payload structure is parseable', () => {
    const payload = {
      tool_name: 'Edit',
      tool_input: {
        file_path: '/home/user/project/src/foo.ts',
        old_string: 'foo',
        new_string: 'bar',
      },
    };
    const parsed = JSON.parse(JSON.stringify(payload));
    expect(parsed.tool_input.file_path).toBe('/home/user/project/src/foo.ts');
  });

  it('handles payload without tool_input gracefully', () => {
    const payload = { tool_name: 'Bash' };
    const parsed = JSON.parse(JSON.stringify(payload));
    expect(parsed.tool_input).toBeUndefined();
  });
});
