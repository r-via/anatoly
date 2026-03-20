// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

export class RagProgressDisplay {
  private activeFiles = new Set<string>();
  private spinFrame = 0;

  trackFile(filePath: string): void {
    this.activeFiles.add(filePath);
  }

  untrackFile(filePath: string): void {
    this.activeFiles.delete(filePath);
  }

  get hasActiveFiles(): boolean {
    return this.activeFiles.size > 0;
  }

  render(): string {
    this.spinFrame++;
    const marker = chalk.yellow('\u25cf');
    const frame = SPINNER[this.spinFrame % SPINNER.length];
    return [...this.activeFiles]
      .map((file) => `${marker} [${chalk.yellow(frame)}] ${file}`)
      .join('\n');
  }
}
