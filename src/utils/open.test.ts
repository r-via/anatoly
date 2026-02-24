import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:os', () => ({
  platform: vi.fn(),
}));

describe('openFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('should use xdg-open on linux', async () => {
    vi.mocked(platform).mockReturnValue('linux');
    vi.mocked(execFile).mockImplementation((() => {}) as never);

    const { openFile } = await import('./open.js');
    openFile('/tmp/report.md');

    expect(execFile).toHaveBeenCalledWith('xdg-open', ['/tmp/report.md'], expect.any(Function));
  });

  it('should use open on macOS', async () => {
    vi.mocked(platform).mockReturnValue('darwin');
    vi.mocked(execFile).mockImplementation((() => {}) as never);

    const { openFile } = await import('./open.js');
    openFile('/tmp/report.md');

    expect(execFile).toHaveBeenCalledWith('open', ['/tmp/report.md'], expect.any(Function));
  });

  it('should use cmd /c start on Windows', async () => {
    vi.mocked(platform).mockReturnValue('win32');
    vi.mocked(execFile).mockImplementation((() => {}) as never);

    const { openFile } = await import('./open.js');
    openFile('C:\\tmp\\report.md');

    expect(execFile).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'C:\\tmp\\report.md'], expect.any(Function));
  });

  it('should log error on failure without throwing', async () => {
    vi.mocked(platform).mockReturnValue('linux');
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: Function) => {
      if (typeof cb === 'function') cb(new Error('not found'), '', '');
    }) as never);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { openFile } = await import('./open.js');
    openFile('/tmp/report.md');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('could not open report'));
    stderrSpy.mockRestore();
  });
});
