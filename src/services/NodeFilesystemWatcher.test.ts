import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { NodeFilesystemWatcher } from './implementations/NodeFilesystemWatcher';

vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn(),
  },
}));

describe('NodeFilesystemWatcher', () => {
  let watcher: NodeFilesystemWatcher;

  beforeEach(() => {
    watcher = new NodeFilesystemWatcher();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts watching a path', () => {
    const callback = vi.fn();
    const mockWatcher = { close: vi.fn() };
    (fs.watch as any).mockReturnValue(mockWatcher);

    watcher.watch('/test/path', callback);

    expect(fs.watch).toHaveBeenCalledWith('/test/path', { recursive: true }, expect.any(Function));
  });

  it('stops watching', () => {
    const mockWatcher = { close: vi.fn() };
    (fs.watch as any).mockReturnValue(mockWatcher);

    watcher.watch('/test/path', vi.fn());
    watcher.stop();

    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('triggers callback on event', () => {
    const callback = vi.fn();
    let watchCallback: Function = () => {};
    (fs.watch as any).mockImplementation((path: any, options: any, cb: any) => {
      watchCallback = cb;
      return { close: vi.fn() };
    });

    watcher.watch('/test/path', callback);
    watchCallback('change', 'test.md');

    expect(callback).toHaveBeenCalledWith('change', 'test.md');
  });
});
