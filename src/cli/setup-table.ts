// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';

export interface SetupTableData {
  project?: { name: string; version: string; languages?: string; frameworks?: string };
  config: { key: string; value: string }[];
  axes: { key: string; value: string }[];
  pipeline: { phase: string; detail: string }[];
}

export function shortModelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function renderSetupTable(data: SetupTableData, plain: boolean): void {
  const checkPrefix = 2; // "✔ " visible chars prepended to pipeline phase
  // Build project rows for width calculation
  const projectRows: { key: string; value: string }[] = [];
  if (data.project) {
    projectRows.push({ key: 'name', value: data.project.name });
    projectRows.push({ key: 'version', value: data.project.version });
    if (data.project.languages) projectRows.push({ key: 'languages', value: data.project.languages });
    if (data.project.frameworks) projectRows.push({ key: 'frameworks', value: data.project.frameworks });
  }
  const allKeys = [
    ...projectRows.map(r => r.key),
    ...data.config.map(r => r.key),
    ...data.axes.map(r => r.key),
    ...data.pipeline.map(r => r.phase),
  ];
  const keyWidth = Math.max(...allKeys.map(k => k.length), checkPrefix);

  const allValues = [
    ...projectRows.map(r => r.value),
    ...data.config.map(r => r.value),
    ...data.axes.map(r => r.value),
    ...data.pipeline.map(r => r.detail),
  ];
  const valWidth = Math.max(...allValues.map(v => v.length));

  const gap = 4; // spacing between key and value columns
  // inner width = 3 (left pad) + keyWidth + gap + valWidth + 2 (right pad)
  const innerWidth = 3 + keyWidth + gap + valWidth + 2;

  if (plain) {
    if (data.project) {
      console.log(chalk.dim('  Project Info'));
      console.log(`    ${'name'.padEnd(keyWidth)}${' '.repeat(gap)}${data.project.name}`);
      console.log(`    ${'version'.padEnd(keyWidth)}${' '.repeat(gap)}${data.project.version}`);
      if (data.project.languages) console.log(`    ${'languages'.padEnd(keyWidth)}${' '.repeat(gap)}${data.project.languages}`);
      if (data.project.frameworks) console.log(`    ${'frameworks'.padEnd(keyWidth)}${' '.repeat(gap)}${data.project.frameworks}`);
    }
    console.log(chalk.dim('  Configuration'));
    for (const r of data.config) console.log(`    ${r.key.padEnd(keyWidth)}${' '.repeat(gap)}${r.value}`);
    console.log(chalk.dim('  Evaluation Axes'));
    for (const r of data.axes) console.log(`    ${r.key.padEnd(keyWidth)}${' '.repeat(gap)}${r.value}`);
    console.log(chalk.dim('  Pipeline Summary'));
    for (const r of data.pipeline) console.log(`    ✔ ${r.phase.padEnd(keyWidth)}${' '.repeat(gap)}${r.detail}`);
    console.log('');
    return;
  }

  const d = chalk.dim;
  const line = (char: string, n: number) => char.repeat(n);

  const sectionBorder = (label: string, color: (s: string) => string, left: string, right: string) => {
    const labelPart = ` ${label} `;
    const dashes = innerWidth - labelPart.length;
    return d(`  ${left}`) + color(labelPart) + d(`${line('─', dashes)}${right}`);
  };

  const kvRow = (key: string, value: string) =>
    `  ${d('│')}   ${key.padEnd(keyWidth)}${' '.repeat(gap)}${value.padEnd(valWidth)}  ${d('│')}`;

  const checkMark = chalk.green('✔');
  // ✔ + space = checkPrefix visible chars; shrink phase pad to compensate
  const pipelineRow = (phase: string, detail: string) =>
    `  ${d('│')}   ${checkMark} ${phase.padEnd(keyWidth - checkPrefix)}${' '.repeat(gap)}${detail.padEnd(valWidth)}  ${d('│')}`;

  const emptyRow = `  ${d('│')}${' '.repeat(innerWidth)}${d('│')}`;

  // project info section
  if (data.project) {
    console.log(sectionBorder('Project Info', chalk.green, '┌', '┐'));
    console.log(emptyRow);
    console.log(kvRow('name', data.project.name));
    console.log(kvRow('version', data.project.version));
    if (data.project.languages) console.log(kvRow('languages', data.project.languages));
    if (data.project.frameworks) console.log(kvRow('frameworks', data.project.frameworks));
    console.log(emptyRow);

    // config section (connected to project info)
    console.log(sectionBorder('Configuration', chalk.cyan, '├', '┤'));
  } else {
    // config section (top of box)
    console.log(sectionBorder('Configuration', chalk.cyan, '┌', '┐'));
  }
  console.log(emptyRow);
  for (const r of data.config) console.log(kvRow(r.key, r.value));
  console.log(emptyRow);

  // axes section
  console.log(sectionBorder('Evaluation Axes', chalk.magenta, '├', '┤'));
  console.log(emptyRow);
  for (const r of data.axes) console.log(kvRow(r.key, r.value));
  console.log(emptyRow);

  // pipeline section
  console.log(sectionBorder('Pipeline Summary', chalk.blue, '├', '┤'));
  console.log(emptyRow);
  for (const r of data.pipeline) console.log(pipelineRow(r.phase, r.detail));
  console.log(emptyRow);

  // bottom border
  console.log(d(`  └${line('─', innerWidth)}┘`));
  console.log('');
}
