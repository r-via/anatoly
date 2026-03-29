// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { createBashTool } from './bash-tool.js';

describe('createBashTool', () => {
  it('returns a tool with description mentioning read-only when allowWrite is false', () => {
    const tool = createBashTool({ allowWrite: false });
    expect(tool.description).toMatch(/read[- ]only/i);
  });

  it('returns a tool with write access when allowWrite is true', () => {
    const tool = createBashTool({ allowWrite: true });
    expect(tool.description).not.toMatch(/read[- ]only/i);
  });

  it('defaults to read-only when allowWrite is omitted', () => {
    const tool = createBashTool({});
    expect(tool.description).toMatch(/read[- ]only/i);
  });

  it('execute runs a command and returns stdout', async () => {
    const tool = createBashTool({ allowWrite: true });
    const result = await tool.execute({ command: 'echo hello' });
    expect(result).toContain('hello');
  });

  it('read-only mode blocks write commands', async () => {
    const tool = createBashTool({ allowWrite: false });
    await expect(tool.execute({ command: 'rm -rf /tmp/test-file' })).rejects.toThrow(/read-only/i);
  });

  it('read-only mode allows read commands', async () => {
    const tool = createBashTool({ allowWrite: false });
    const result = await tool.execute({ command: 'echo hello' });
    expect(result).toContain('hello');
  });
});
