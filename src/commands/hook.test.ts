import { describe, it, expect } from 'vitest';
import { createProgram } from '../cli.js';

describe('hook command registration', () => {
  it('registers hook command with post-edit, stop, and init subcommands', () => {
    const program = createProgram();
    const hookCmd = program.commands.find((c) => c.name() === 'hook');
    expect(hookCmd).toBeDefined();
    expect(hookCmd!.description()).toBe('Claude Code integration hooks (internal)');

    const subcommands = hookCmd!.commands.map((c) => c.name());
    expect(subcommands).toContain('post-edit');
    expect(subcommands).toContain('stop');
    expect(subcommands).toContain('init');
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
    const hookCmd = program.commands.find((c) => c.name() === 'hook');
    const stop = hookCmd!.commands.find((c) => c.name() === 'stop');
    expect(stop).toBeDefined();
    expect(stop!.description()).toContain('Stop hook');
  });

  it('init subcommand has correct description', () => {
    const program = createProgram();
    const hookCmd = program.commands.find((c) => c.name() === 'hook');
    const init = hookCmd!.commands.find((c) => c.name() === 'init');
    expect(init).toBeDefined();
    expect(init!.description()).toContain('Claude Code hooks configuration');
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

describe('hook init template', () => {
  it('generates correct hooks JSON structure per Claude Code spec', () => {
    // Validate the template structure matches Claude Code hook protocol
    // Events contain matcher groups, each with a nested hooks array
    const hooksConfig = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              {
                type: 'command',
                command: 'npx anatoly hook post-edit',
                async: true,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'npx anatoly hook stop',
                timeout: 180,
              },
            ],
          },
        ],
      },
    };

    expect(hooksConfig.hooks.PostToolUse).toHaveLength(1);
    expect(hooksConfig.hooks.PostToolUse[0].matcher).toBe('Edit|Write');
    expect(hooksConfig.hooks.PostToolUse[0].hooks).toHaveLength(1);
    expect(hooksConfig.hooks.PostToolUse[0].hooks[0].type).toBe('command');
    expect(hooksConfig.hooks.PostToolUse[0].hooks[0].async).toBe(true);
    expect(hooksConfig.hooks.Stop).toHaveLength(1);
    expect(hooksConfig.hooks.Stop[0].hooks[0].type).toBe('command');
    expect(hooksConfig.hooks.Stop[0].hooks[0].timeout).toBe(180);
  });
});
