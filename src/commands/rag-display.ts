// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

export class RagProgressDisplay {
  private activeFiles = new Set<string>();

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
    return [...this.activeFiles].join('\n');
  }
}
