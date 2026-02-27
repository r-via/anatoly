import chalk from 'chalk';
import type { AxisId } from '../core/axis-evaluator.js';
import type { ReviewFile } from '../schemas/review.js';

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

const AXIS_LABELS: Record<string, string> = {
  utility: 'utility',
  duplication: 'duplication',
  overengineering: 'overengineering',
  tests: 'tests',
  correction: 'correction',
  best_practices: 'best practices',
};

export interface ActiveFileState {
  axes: Set<string>;
  retryMsg?: string;
}

export class ReviewProgressDisplay {
  private activeFiles = new Map<string, ActiveFileState>();
  private spinFrame = 0;

  constructor(private axisIds: AxisId[]) {}

  trackFile(filePath: string): void {
    this.activeFiles.set(filePath, { axes: new Set() });
  }

  markAxisDone(filePath: string, axisId: AxisId): void {
    const state = this.activeFiles.get(filePath);
    if (state) {
      state.retryMsg = undefined;
      state.axes.add(axisId);
    }
  }

  setRetryMessage(filePath: string, msg: string): void {
    const state = this.activeFiles.get(filePath);
    if (state) state.retryMsg = msg;
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
    const files = [...this.activeFiles.entries()];
    const maxLen = files.length > 0 ? Math.max(...files.map(([f]) => f.length)) : 0;
    const lines: string[] = [];
    for (const [file, state] of files) {
      const padded = file.padEnd(maxLen);
      if (state.retryMsg) {
        lines.push(`${marker} ${padded}  ${state.retryMsg}`);
      } else {
        lines.push(`${marker} ${padded}  ${this.formatAxes(state.axes)}`);
      }
    }
    return lines.join('\n');
  }

  private formatAxes(done: Set<string>): string {
    const frame = SPINNER[this.spinFrame % SPINNER.length];
    return this.axisIds.map((id) => {
      const label = AXIS_LABELS[id] ?? id;
      return done.has(id) ? `${chalk.green('[x]')} ${label}` : `[${chalk.yellow(frame)}] ${label}`;
    }).join(' ');
  }
}

export function countReviewFindings(review: ReviewFile, minConfidence: number = 0): number {
  let findings = 0;
  for (const s of review.symbols) {
    if (s.confidence < minConfidence) continue;
    if (s.utility === 'DEAD') findings++;
    if (s.duplication === 'DUPLICATE') findings++;
    if (s.overengineering === 'OVER') findings++;
    if (s.correction === 'NEEDS_FIX' || s.correction === 'ERROR') findings++;
  }
  return findings;
}
