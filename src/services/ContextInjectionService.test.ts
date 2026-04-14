import { describe, it, expect, beforeEach } from 'vitest';
import { ContextInjectionService } from './ContextInjectionService';
import { MockFileSystem } from './mocks/MockServices';
import * as path from 'node:path';

describe('ContextInjectionService', () => {
  let mockFs: MockFileSystem;
  let service: ContextInjectionService;
  const rootDir = '/root';

  beforeEach(() => {
    mockFs = new MockFileSystem();
    service = new ContextInjectionService(mockFs, rootDir);
    
    // Setup basic track structure
    mockFs.mkdir(path.join(rootDir, '.meridian/tracks/track-1'));
  });

  describe('isForbidden', () => {
    it('should block .env files', () => {
      expect(service.isForbidden('.env')).toBe(true);
      expect(service.isForbidden('.env.local')).toBe(true);
      expect(service.isForbidden('/root/.env')).toBe(true);
    });

    it('should block .git directory and files inside', () => {
      expect(service.isForbidden('.git')).toBe(true);
      expect(service.isForbidden('.git/config')).toBe(true);
      expect(service.isForbidden('/root/.git/HEAD')).toBe(true);
    });

    it('should block node_modules directory and files inside', () => {
      expect(service.isForbidden('node_modules')).toBe(true);
      expect(service.isForbidden('node_modules/lodash/index.js')).toBe(true);
    });

    it('should block package-lock.json', () => {
      expect(service.isForbidden('package-lock.json')).toBe(true);
      expect(service.isForbidden('/root/package-lock.json')).toBe(true);
    });

    it('should block yarn.lock and pnpm-lock.yaml', () => {
      expect(service.isForbidden('yarn.lock')).toBe(true);
      expect(service.isForbidden('pnpm-lock.yaml')).toBe(true);
    });

    it('should block .DS_Store', () => {
      expect(service.isForbidden('.DS_Store')).toBe(true);
    });

    it('should allow non-sensitive files', () => {
      expect(service.isForbidden('spec.md')).toBe(false);
      expect(service.isForbidden('src/index.ts')).toBe(false);
      expect(service.isForbidden('/root/.meridian/tracks/track-1/spec.md')).toBe(false);
    });
  });

  describe('injectTrackContext', () => {
    it('should inject markdown files from a track', () => {
      const trackId = 'track-1';
      const trackPath = path.join(rootDir, '.meridian/tracks', trackId);
      
      mockFs.__setupFile(path.join(trackPath, 'spec.md'), '# Spec Content');
      mockFs.__setupFile(path.join(trackPath, 'plan.md'), '# Plan Content');
      
      const result = service.injectTrackContext(trackId);
      
      expect(result).toContain('# Context for Track: track-1');
      expect(result).toContain('## File: spec.md');
      expect(result).toContain('# Spec Content');
      expect(result).toContain('## File: plan.md');
      expect(result).toContain('# Plan Content');
    });

    it('should return empty string if track does not exist', () => {
      const result = service.injectTrackContext('nonexistent');
      expect(result).toBe('');
    });

    it('should NOT inject forbidden files even if they are in the track directory', () => {
      const trackId = 'track-1';
      const trackPath = path.join(rootDir, '.meridian/tracks', trackId);
      
      mockFs.__setupFile(path.join(trackPath, 'spec.md'), '# Spec');
      mockFs.__setupFile(path.join(trackPath, '.env'), 'SECRET_KEY=123');
      mockFs.__setupFile(path.join(trackPath, 'package-lock.json'), '{}');
      
      const result = service.injectTrackContext(trackId);
      
      expect(result).toContain('## File: spec.md');
      expect(result).not.toContain('.env');
      expect(result).not.toContain('SECRET_KEY');
      expect(result).not.toContain('package-lock.json');
    });

    it('should skip directories and non-markdown files', () => {
      const trackId = 'track-1';
      const trackPath = path.join(rootDir, '.meridian/tracks', trackId);
      
      mockFs.mkdir(path.join(trackPath, 'subfolder'));
      mockFs.__setupFile(path.join(trackPath, 'image.png'), 'binary data');
      mockFs.__setupFile(path.join(trackPath, 'spec.md'), '# Spec');
      
      const result = service.injectTrackContext(trackId);
      
      expect(result).toContain('## File: spec.md');
      expect(result).not.toContain('subfolder');
      expect(result).not.toContain('image.png');
    });
  });
});
