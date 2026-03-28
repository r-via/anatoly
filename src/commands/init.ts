// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { ConfigSchema } from '../schemas/config.js';

const CONFIG_FILENAME = '.anatoly.yml';

/**
 * Generate an example .anatoly.yml from the Zod schema defaults.
 * Every line is commented out so the file is documentation-only until the user
 * uncomments what they want to customize.
 */
function generateExampleConfig(): string {
  const defaults = ConfigSchema.parse({});
  const yamlStr = yaml.dump(defaults, { lineWidth: 120 });
  const commented = yamlStr
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `# ${line}`))
    .join('\n');

  return `# Anatoly configuration — uncomment and customize as needed.\n# All values shown are defaults.\n\n${commented}`;
}

/**
 * Registers the `init` CLI sub-command on the given Commander program.
 *
 * The command writes a `.anatoly.yml` file with all schema defaults commented out.
 * If the file already exists, it exits with code 1 unless `--force` is passed.
 *
 * @param program - The root Commander instance.
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Generate a .anatoly.yml config file with all defaults (commented out)')
    .option('--force', 'overwrite existing .anatoly.yml')
    .action((opts: { force?: boolean }) => {
      const projectRoot = process.cwd();
      const configPath = resolve(projectRoot, CONFIG_FILENAME);

      if (existsSync(configPath) && !opts.force) {
        console.error(chalk.yellow(`${CONFIG_FILENAME} already exists. Use --force to overwrite.`));
        process.exit(1);
      }

      const content = generateExampleConfig();
      writeFileSync(configPath, content);
      console.log(chalk.green(`${CONFIG_FILENAME} created with all defaults (commented out).`));
    });
}
