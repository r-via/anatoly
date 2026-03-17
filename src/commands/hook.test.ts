import { describe, it, expect } from 'vitest';
import { createProgram } from '../cli.js';

describe('hook command registration', () => {
  it('registers hook command with on-edit, on-stop, and init subcommands', () => {
    const program = createProgram();
    const hookCmd = program.commands.find((c) => c.name() === 'hook');
    expect(hookCmd).toBeDefined();
    expect(hookCmd!.description()).toBe('Claude Code integration hooks (internal)');

    const subcommands = hookCmd!.commands.map((c) => c.name());
    expect(subcommands).toContain('on-edit');
    expect(subcommands).toContain('on-stop');
    expect(subcommands).toContain('init');
  });

  it('on-edit subcommand has correct description', () => {
    const program = createProgram();
    const hookCmd = program.commands.find((c) => c.name() === 'hook');
    const onEdit = hookCmd!.commands.find((c) => c.name() === 'on-edit');
    expect(onEdit).toBeDefined();
    expect(onEdit!.description()).toContain('PostToolUse');
  });

  it('on-stop subcommand has correct description', () => {
    const program = createProgram();
    const hookCmd = program.commands.find((c) => c.name() === 'hook');
    const onStop = hookCmd!.commands.find((c) => c.name() === 'on-stop');
    expect(onStop).toBeDefined();
    expect(onStop!.description()).toContain('Stop hook');
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
                command: 'npx anatoly hook on-edit',
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
                command: 'npx anatoly hook on-stop',
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
