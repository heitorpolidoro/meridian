import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { NodeFilesystemWatcher } from './implementations/NodeFilesystemWatcher';

// Mock the fs module
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
    // Using a properly typed mock for FSWatcher to avoid 'any'
    const mockWatcher = { 
      close: vi.fn(() => { 
        /* Mock close implementation for testing purposes */ 
      }) 
    } as unknown as fs.FSWatcher;

    vi.mocked(fs.watch).mockReturnValue(mockWatcher);

    watcher.watch('/test/path', callback);

    expect(fs.watch).toHaveBeenCalledWith('/test/path', { recursive: true }, expect.any(Function));
  });

  it('stops watching', () => {
    const mockWatcher = { 
      close: vi.fn(() => { 
        /* Mock close implementation for testing purposes */ 
      }) 
    } as unknown as fs.FSWatcher;

    vi.mocked(fs.watch).mockReturnValue(mockWatcher);

    watcher.watch('/test/path', vi.fn());
    watcher.stop();

    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('triggers callback on event', () => {
    const callback = vi.fn();
    let watchCallback: (event: string, filename: string | null) => void = () => {
      /* Initial placeholder function for the watcher callback */
    };
    
    vi.mocked(fs.watch).mockImplementation((_path: fs.PathLike, _options: fs.WatchOptions | string | undefined | null, cb?: (event: string, filename: string | null) => void) => {
      if (cb) {
        watchCallback = cb;
      }
      return { 
        close: vi.fn(() => { 
          /* Mock close implementation for testing purposes */ 
        }) 
      } as unknown as fs.FSWatcher;
    });

    watcher.watch('/test/path', callback);
    watchCallback('change', 'test.md');

    expect(callback).toHaveBeenCalledWith('change', 'test.md');
  });

  it('handles errors when starting watcher', () => {
    const error = new Error('Test error');
    // Using mockImplementationOnce for isolation and avoid leakage to other tests
    vi.mocked(fs.watch).mockImplementationOnce(() => {
      throw error;
    });

    // Mock implementation of console.error with a comment to avoid 'empty function' smell
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* Intentionally silenced for testing to keep logs clean */
    });

    try {
      watcher.watch('/test/path', vi.fn());
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error starting watcher:', error);
    } finally {
      // Ensure the spy is always restored, even if the expectation fails
      consoleErrorSpy.mockRestore();
    }
  });
});
