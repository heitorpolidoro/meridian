import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextInjectionService } from '../ContextInjectionService';
import { MockFileSystem } from '../mocks/MockServices';
import * as path from 'node:path';

describe('IsolationIntegrity', () => {
  let mockFs: MockFileSystem;
  let service: ContextInjectionService;
  const rootDir = '/root';

  beforeEach(() => {
    mockFs = new MockFileSystem();
    service = new ContextInjectionService(mockFs, rootDir);
    
    // Setup two tracks in .meridian/tracks
    const tracksDir = path.join(rootDir, '.meridian/tracks');
    mockFs.mkdir(tracksDir);
    
    const trackADir = path.join(tracksDir, 'track-a');
    mockFs.mkdir(trackADir);
    mockFs.__setupFile(path.join(trackADir, 'spec.md'), '# Track A Spec');
    
    const trackBDir = path.join(tracksDir, 'track-b');
    mockFs.mkdir(trackBDir);
    mockFs.__setupFile(path.join(trackBDir, 'spec.md'), '# Track B Spec');
    
    // Setup product.md in .meridian root
    mockFs.__setupFile(path.join(rootDir, '.meridian/product.md'), '# Product Vision');
  });

  it('should call injectTrackContext("track-a") and assert that content from "track-b" is NOT present', () => {
    const context = service.injectTrackContext('track-a');
    
    expect(context).toContain('# Track A Spec');
    expect(context).not.toContain('# Track B Spec');
  });

  it('should prepend product.md content if it exists', () => {
    const context = service.injectTrackContext('track-a');
    
    expect(context).toContain('## Product Vision');
    expect(context).toContain('# Product Vision');
  });

  it('should block directory traversal patterns and log an error', () => {
    // Attempting to access track-b via traversal
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    const context = service.injectTrackContext('track-a/../../tracks/track-b');
    
    expect(context).not.toContain('# Track B Spec');
    expect(context).toBe('');
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0][0]).toContain('Isolation breach attempt detected');
    
    errorSpy.mockRestore();
  });

  it('should block out-of-bounds attempts even without traversal patterns', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Requesting '.' (the tracks directory itself) should be blocked as it's not a specific track
    const context = service.injectTrackContext('.');
    
    expect(context).toBe('');
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0][0]).toContain('Isolation breach attempt detected (out-of-bounds)');
    
    errorSpy.mockRestore();
  });
});
