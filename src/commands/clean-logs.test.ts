import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('clean-logs logic', () => {
  let tmpDir: string;
  let logsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clean-logs-test-'));
    logsDir = join(tmpDir, '.anatoly', 'logs');
    mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should delete transcript files', () => {
    writeFileSync(join(logsDir, 'src-utils-helper.transcript.md'), 'transcript content');
    writeFileSync(join(logsDir, 'src-core-scanner.transcript.md'), 'transcript content');

    const entries = readdirSync(logsDir);
    let deleted = 0;
    for (const entry of entries) {
      if (entry.endsWith('.transcript.md')) {
        unlinkSync(join(logsDir, entry));
        deleted++;
      }
    }

    expect(deleted).toBe(2);
    expect(existsSync(join(logsDir, 'src-utils-helper.transcript.md'))).toBe(false);
  });

  it('should not delete non-transcript files', () => {
    writeFileSync(join(logsDir, 'other.log'), 'log content');
    writeFileSync(join(logsDir, 'a.transcript.md'), 'transcript');

    const entries = readdirSync(logsDir);
    for (const entry of entries) {
      if (entry.endsWith('.transcript.md')) {
        unlinkSync(join(logsDir, entry));
      }
    }

    expect(existsSync(join(logsDir, 'other.log'))).toBe(true);
    expect(existsSync(join(logsDir, 'a.transcript.md'))).toBe(false);
  });
});
