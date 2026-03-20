// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

export class RagProgressDisplay {
  private completedPhases: string[] = [];
  private activeFiles = new Set<string>();
  private spinFrame = 0;

  completePhase(label: string): void {
    this.completedPhases.push(label);
  }

  trackFile(filePath: string): void {
    this.activeFiles.add(filePath);
  }

  untrackFile(filePath: string): void {
    this.activeFiles.delete(filePath);
  }

  get hasContent(): boolean {
    return this.completedPhases.length > 0 || this.activeFiles.size > 0;
  }

  render(): string {
    this.spinFrame++;
    const frame = SPINNER[this.spinFrame % SPINNER.length];
    const lines: string[] = [];

    for (const phase of this.completedPhases) {
      lines.push(`${chalk.green('\u2714')} ${phase}`);
    }

    for (const file of this.activeFiles) {
      lines.push(`${chalk.yellow(frame)} ${file}`);
    }

    return lines.join('\n');
  }
}
