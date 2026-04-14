import { describe, it, expect, beforeEach } from 'vitest';
import { BootstrappingService } from './BootstrappingService';
import { MockFileSystem } from './mocks/MockServices';
import * as path from 'node:path';

describe('BootstrappingService', () => {
  let mockFs: MockFileSystem;
  let service: BootstrappingService;
  const rootDir = '/root';

  beforeEach(() => {
    mockFs = new MockFileSystem();
    service = new BootstrappingService(mockFs, rootDir);

    // Setup basic hierarchy
    mockFs.mkdir(path.join(rootDir, 'agents_core/core'));
    mockFs.mkdir(path.join(rootDir, 'agents_core/roles'));
    mockFs.mkdir(path.join(rootDir, '.gemini/agents'));

    mockFs.writeFile(path.join(rootDir, 'agents_core/core/global.md'), '# Global Standards');
    mockFs.writeFile(path.join(rootDir, 'agents_core/core/backend.md'), '# Backend Standards');
    
    mockFs.writeFile(path.join(rootDir, 'agents_core/roles/architect.md'), 
`# Role: Architect
@../core/backend.md
Some instructions.`);

    mockFs.writeFile(path.join(rootDir, '.gemini/agents/architect.md'), 
`---
name: architect
---
# Stub
@../../agents_core/roles/architect.md`);
  });

  it('should resolve full hierarchy with global standards first', () => {
    const result = service.resolve('architect');
    
    expect(result).toContain('# Global Standards');
    expect(result).toContain('# Backend Standards');
    expect(result).toContain('# Role: Architect');
    expect(result).toContain('# Stub');
    
    // Check order
    const globalIdx = result.indexOf('# Global Standards');
    const stubIdx = result.indexOf('# Stub');
    const roleIdx = result.indexOf('# Role: Architect');
    const backendIdx = result.indexOf('# Backend Standards');
    
    expect(globalIdx).toBeLessThan(stubIdx);
    expect(stubIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(backendIdx);
  });

  it('should throw error if global standards file is missing in resolve()', () => {
    mockFs.deleteFile(path.join(rootDir, 'agents_core/core/global.md'));
    expect(() => service.resolve('architect')).toThrow('Global standards file not found');
  });

  it('should still resolve agent if global standards file is missing in resolveAgent()', () => {
    mockFs.deleteFile(path.join(rootDir, 'agents_core/core/global.md'));
    const result = service.resolveAgent('architect');
    expect(result).toContain('# Role: Architect');
    expect(result).not.toContain('# Global Standards');
  });

  it('should prevent double inclusion of global standards', () => {
    // Modify architect.md to also link to global.md
    mockFs.writeFile(path.join(rootDir, 'agents_core/roles/architect.md'), 
`@../core/global.md
# Role: Architect`);

    const result = service.resolve('architect');
    
    const globalMatches = result.match(/# Global Standards/g);
    expect(globalMatches).toHaveLength(1);
  });

  it('should handle missing linked files gracefully by including error message in content', () => {
    mockFs.writeFile(path.join(rootDir, 'agents_core/roles/missing.md'), '@../core/notfound.md');
    mockFs.writeFile(path.join(rootDir, '.gemini/agents/missing.md'), '@../../agents_core/roles/missing.md');

    const result = service.resolve('missing');
    expect(result).toContain('[Error: File not found:');
  });

  it('should throw error if stub file itself is missing', () => {
    expect(() => service.resolve('nonexistent')).toThrow('Stub file not found');
  });

  it('should resolve deep recursion', () => {
    mockFs.writeFile(path.join(rootDir, 'agents_core/core/base.md'), '# Base Standards');
    mockFs.writeFile(path.join(rootDir, 'agents_core/core/backend.md'), 
`# Backend Standards
@./base.md`);
    
    const result = service.resolve('architect');
    expect(result).toContain('# Base Standards');
    expect(result).toContain('# Backend Standards');
    
    const backendIdx = result.indexOf('# Backend Standards');
    const baseIdx = result.indexOf('# Base Standards');
    expect(backendIdx).toBeLessThan(baseIdx);
  });
});
