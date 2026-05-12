// SPDX-License-Identifier: AGPL-3.0-only
// Documentation regression — `runs attach` (formerly Story 53.7)

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

describe('runs attach documentation', () => {
  it('CLI Reference Commands.md contains runs attach section', () => {
    const commandsDoc = readFileSync(resolve(ROOT, 'docs/03-CLI-Reference/01-Commands.md'), 'utf-8');
    expect(commandsDoc).toContain('## runs attach');
    expect(commandsDoc).toContain('--from-start');
    expect(commandsDoc).toContain('--no-color');
    expect(commandsDoc).toContain('Ctrl-C to detach');
  });

  it('CLI Reference contains runs list section', () => {
    const commandsDoc = readFileSync(resolve(ROOT, 'docs/03-CLI-Reference/01-Commands.md'), 'utf-8');
    expect(commandsDoc).toContain('## runs list');
  });

  it('top-level status / attach sections are removed', () => {
    const commandsDoc = readFileSync(resolve(ROOT, 'docs/03-CLI-Reference/01-Commands.md'), 'utf-8');
    expect(commandsDoc).not.toMatch(/^## status$/m);
    expect(commandsDoc).not.toMatch(/^## attach$/m);
  });
});
