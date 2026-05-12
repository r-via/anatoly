// SPDX-License-Identifier: AGPL-3.0-only
// Story 53.7 — attach documentation validation

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

describe('attach documentation', () => {
  it('CLI Reference Commands.md contains attach section', () => {
    const commandsDoc = readFileSync(resolve(ROOT, 'docs/03-CLI-Reference/01-Commands.md'), 'utf-8');
    expect(commandsDoc).toContain('## attach');
    expect(commandsDoc).toContain('--from-start');
    expect(commandsDoc).toContain('--no-color');
    expect(commandsDoc).toContain('Ctrl-C to detach');
  });

  it('status section references attach', () => {
    const commandsDoc = readFileSync(resolve(ROOT, 'docs/03-CLI-Reference/01-Commands.md'), 'utf-8');
    const statusSection = commandsDoc.split('## status')[1]?.split('## attach')[0] ?? '';
    expect(statusSection).toContain('attach');
  });

  it('README.md mentions anatoly attach', () => {
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf-8');
    expect(readme).toContain('anatoly attach');
  });

  it('CHANGELOG.md documents Epic 53', () => {
    const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf-8');
    expect(changelog).toContain('Epic 53');
    expect(changelog).toContain('anatoly attach');
  });

  it('attach internal link in Commands.md is valid (#attach anchor)', () => {
    const commandsDoc = readFileSync(resolve(ROOT, 'docs/03-CLI-Reference/01-Commands.md'), 'utf-8');
    // The status section references attach via a markdown link
    expect(commandsDoc).toContain('[`attach`](#attach)');
    // And the attach section exists as a heading
    expect(commandsDoc).toMatch(/^## attach$/m);
  });
});
