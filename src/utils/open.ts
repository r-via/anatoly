import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Open a file with the system's default application.
 * Uses xdg-open on Linux, open on macOS, start on Windows.
 */
export function openFile(filePath: string): void {
  const p = platform();
  let cmd: string;
  let args: string[];

  if (p === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (p === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    cmd = 'xdg-open';
    args = [filePath];
  }

  execFile(cmd, args, (error) => {
    if (error) {
      // Silently fail — opening the report is a convenience, not critical
      console.error(`  could not open report: ${error.message}`);
    }
  });
}
