// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';

/**
 * Data structure consumed by {@link renderSetupTable} to build the setup
 * summary output (either a Unicode box-drawing table or plain-text lines).
 *
 * @property project - Optional project metadata (name, version, detected
 *   languages/frameworks). Omit for non-Node or anonymous projects.
 * @property config - Key-value rows for the "Configuration" section.
 * @property models - Left column of the "Used Models" section (axes + deliberation).
 * @property modelsRight - Right column of the "Used Models" section (embeddings, chunking, etc.).
 * @property pipeline - Rows for the "Pipeline Summary" section.
 */
export interface SetupTableData {
  project?: { name: string; version: string; languages?: string; frameworks?: string };
  config: { key: string; value: string }[];
  models: { key: string; value: string }[];
  modelsRight?: { key: string; value: string }[];
  pipeline: { phase: string; detail: string }[];
}

/**
 * Strips the `claude-` prefix and any trailing 8-digit date suffix from a
 * model identifier to produce a shorter display name.
 *
 * @example
 * shortModelName('claude-3-5-sonnet-20241022'); // => '3-5-sonnet'
 *
 * @param model - Full model identifier string (e.g. `"claude-3-5-sonnet-20241022"`).
 * @returns The abbreviated model name suitable for display in tables and logs.
 */
export function shortModelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/**
 * Renders a multi-section setup summary to stdout.
 *
 * When `plain` is `false`, outputs a Unicode box-drawing table with coloured
 * section headers (Project Info, Configuration, Used Models, Pipeline
 * Summary). When `plain` is `true`, outputs indented key-value lines without
 * box characters or ANSI colours, suitable for CI logs and piped output.
 *
 * The "Used Models" section renders as two columns when `modelsRight` is
 * provided, with widths computed dynamically from content.
 *
 * @param data - The {@link SetupTableData} to render.
 * @param plain - When `true`, emit plain-text output instead of a styled table.
 */
export function renderSetupTable(data: SetupTableData, plain: boolean): void {
  const checkPrefix = 2; // "✔ " visible chars prepended to pipeline phase
  const gap = 4; // spacing between key and value columns
  const hasRight = data.modelsRight && data.modelsRight.length > 0;

  // Build project rows for width calculation
  const projectRows: { key: string; value: string }[] = [];
  if (data.project) {
    projectRows.push({ key: 'name', value: data.project.name });
    projectRows.push({ key: 'version', value: data.project.version });
    if (data.project.languages) projectRows.push({ key: 'languages', value: data.project.languages });
    if (data.project.frameworks) projectRows.push({ key: 'frameworks', value: data.project.frameworks });
  }

  // --- Compute left-column widths (used by all single-column sections) ---
  const singleColRows = [
    ...projectRows,
    ...data.config,
    ...data.pipeline.map(r => ({ key: r.phase, value: r.detail })),
  ];
  const singleKeyWidth = Math.max(
    ...singleColRows.map(r => r.key.length),
    ...data.pipeline.map(r => r.phase.length + checkPrefix),
    0,
  );
  const singleValWidth = Math.max(...singleColRows.map(r => r.value.length), 0);

  // --- Compute two-column models widths ---
  const lKeyW = Math.max(...data.models.map(r => r.key.length), 0);
  const lValW = Math.max(...data.models.map(r => r.value.length), 0);
  const leftColWidth = 3 + lKeyW + gap + lValW; // pad + key + gap + value

  let rKeyW = 0;
  let rValW = 0;
  if (hasRight) {
    rKeyW = Math.max(...data.modelsRight!.map(r => r.key.length), 0);
    rValW = Math.max(...data.modelsRight!.map(r => r.value.length), 0);
  }
  const rightColWidth = hasRight ? 2 + rKeyW + gap + rValW + 2 : 0; // pad + key + gap + value + pad
  const separatorWidth = hasRight ? 3 : 0; // " │ "

  // Models section inner width
  const modelsInnerWidth = leftColWidth + separatorWidth + rightColWidth + 2; // +2 right pad

  // Single-column inner width
  const singleInnerWidth = 3 + singleKeyWidth + gap + singleValWidth + 2;

  // Overall inner width = max of all sections
  const innerWidth = Math.max(singleInnerWidth, modelsInnerWidth);

  if (plain) {
    if (data.project) {
      console.log(chalk.dim('  Project Info'));
      console.log(`    ${'name'.padEnd(singleKeyWidth)}${' '.repeat(gap)}${data.project.name}`);
      console.log(`    ${'version'.padEnd(singleKeyWidth)}${' '.repeat(gap)}${data.project.version}`);
      if (data.project.languages) console.log(`    ${'languages'.padEnd(singleKeyWidth)}${' '.repeat(gap)}${data.project.languages}`);
      if (data.project.frameworks) console.log(`    ${'frameworks'.padEnd(singleKeyWidth)}${' '.repeat(gap)}${data.project.frameworks}`);
    }
    console.log(chalk.dim('  Configuration'));
    for (const r of data.config) console.log(`    ${r.key.padEnd(singleKeyWidth)}${' '.repeat(gap)}${r.value}`);
    console.log(chalk.dim('  Used Models'));
    const maxRows = Math.max(data.models.length, data.modelsRight?.length ?? 0);
    for (let i = 0; i < maxRows; i++) {
      const left = data.models[i];
      const right = data.modelsRight?.[i];
      let line = '    ';
      if (left) {
        line += `${left.key.padEnd(lKeyW)}${' '.repeat(gap)}${left.value.padEnd(lValW)}`;
      } else {
        line += ' '.repeat(lKeyW + gap + lValW);
      }
      if (hasRight) {
        line += '    ';
        if (right) {
          line += `${right.key.padEnd(rKeyW)}${' '.repeat(gap)}${right.value}`;
        }
      }
      console.log(line);
    }
    console.log(chalk.dim('  Pipeline Summary'));
    for (const r of data.pipeline) console.log(`    ✔ ${r.phase.padEnd(singleKeyWidth)}${' '.repeat(gap)}${r.detail}`);
    console.log('');
    return;
  }

  const d = chalk.dim;
  const line = (char: string, n: number) => char.repeat(n);

  const sectionBorder = (label: string, color: (s: string) => string, left: string, right: string) => {
    const labelPart = ` ${label} `;
    const dashes = Math.max(0, innerWidth - labelPart.length);
    return d(`  ${left}`) + color(labelPart) + d(`${line('─', dashes)}${right}`);
  };

  // Standard single-column row (padded to full innerWidth)
  const kvRow = (key: string, value: string) => {
    const content = `   ${key.padEnd(singleKeyWidth)}${' '.repeat(gap)}${value}`;
    return `  ${d('│')}${content.padEnd(innerWidth)}${d('│')}`;
  };

  const checkMark = chalk.green('✔');
  const pipelineRow = (phase: string, detail: string) => {
    const visibleContent = `   ✔ ${phase.padEnd(singleKeyWidth - checkPrefix)}${' '.repeat(gap)}${detail}`;
    const content = `   ${checkMark} ${phase.padEnd(singleKeyWidth - checkPrefix)}${' '.repeat(gap)}${detail}`;
    const padding = Math.max(0, innerWidth - visibleContent.length);
    return `  ${d('│')}${content}${' '.repeat(padding)}${d('│')}`;
  };

  const emptyRow = `  ${d('│')}${' '.repeat(innerWidth)}${d('│')}`;

  // Two-column row for the models section
  const modelsRow = (leftItem: { key: string; value: string } | undefined, rightItem: { key: string; value: string } | undefined) => {
    let leftPart = '';
    if (leftItem) {
      leftPart = `   ${leftItem.key.padEnd(lKeyW)}${' '.repeat(gap)}${leftItem.value.padEnd(lValW)}`;
    } else {
      leftPart = ' '.repeat(leftColWidth);
    }

    if (hasRight) {
      const sep = ` ${d('│')} `;
      let rightPart = '';
      if (rightItem) {
        rightPart = `${rightItem.key.padEnd(rKeyW)}${' '.repeat(gap)}${rightItem.value}`;
      }
      // Pad the full row to innerWidth
      const rawContent = leftPart + sep + rightPart;
      // We need to account for the chalk dim chars in sep for padding
      const visibleLength = leftPart.length + 3 + rightPart.length;
      const padding = Math.max(0, innerWidth - visibleLength);
      return `  ${d('│')}${leftPart}${sep}${rightPart}${' '.repeat(padding)}${d('│')}`;
    }

    return `  ${d('│')}${leftPart.padEnd(innerWidth)}${d('│')}`;
  };

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

  // models section (two-column)
  console.log(sectionBorder('Used Models', chalk.magenta, '├', '┤'));
  console.log(emptyRow);
  const maxRows = Math.max(data.models.length, data.modelsRight?.length ?? 0);
  for (let i = 0; i < maxRows; i++) {
    console.log(modelsRow(data.models[i], data.modelsRight?.[i]));
  }
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
