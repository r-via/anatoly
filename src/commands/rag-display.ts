// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

export interface RagFileState {
  phase: 'code' | 'nlp' | 'done';
}

export class RagProgressDisplay {
  private activeFiles = new Map<string, RagFileState>();
  private spinFrame = 0;

  trackFile(filePath: string): void {
    this.activeFiles.set(filePath, { phase: 'code' });
  }

  setPhase(filePath: string, phase: 'code' | 'nlp' | 'done'): void {
    const state = this.activeFiles.get(filePath);
    if (state) state.phase = phase;
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
    const files = [...this.activeFiles.entries()];
    const maxLen = files.length > 0 ? Math.max(...files.map(([f]) => f.length)) : 0;
    const lines: string[] = [];

    for (const [file, state] of files) {
      const padded = file.padEnd(maxLen);
      const codeStatus = state.phase === 'code'
        ? `[${chalk.yellow(frame)}] code`
        : `${chalk.green('[x]')} code`;
      const nlpStatus = state.phase === 'nlp'
        ? `[${chalk.yellow(frame)}] nlp`
        : state.phase === 'done'
          ? `${chalk.green('[x]')} nlp`
          : `${chalk.dim('[ ]')} nlp`;
      lines.push(`${marker} ${padded}  ${codeStatus} ${nlpStatus}`);
    }

    return lines.join('\n');
  }
}
