import * as path from 'node:path';
import { IFileSystem, IContextInjectionService } from './interfaces/ICoreServices';

export class ContextInjectionService implements IContextInjectionService {
  private readonly FORBIDDEN_PATTERNS = [
    '.env',
    '.git',
    'node_modules',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '.DS_Store'
  ];

  constructor(private fs: IFileSystem, private rootDir: string) {}

  /**
   * Validates if a file path is forbidden based on security patterns.
   * Prevents leaking secrets like .env or large dependencies.
   */
  public isForbidden(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const pathParts = normalizedPath.split('/');

    return pathParts.some(part => {
      // Direct match for files or directories in the list
      if (this.FORBIDDEN_PATTERNS.includes(part)) {
        return true;
      }
      
      // Handle extension-based patterns if needed (currently exact match is enough for .env)
      if (part.startsWith('.env')) {
        return true;
      }

      return false;
    });
  }

  /**
   * Dynamically selects and injects relevant files for a specific track.
   * Enforces isolation and secret prevention.
   */
  public injectTrackContext(trackId: string): string {
    const baseTracksDir = path.join(this.rootDir, '.meridian/tracks');
    
    // Strict Isolation Check: block directory traversal patterns
    if (trackId.includes('..')) {
      console.error(`[ERROR] [ContextInjectionService] Isolation breach attempt detected (traversal): ${trackId}`);
      return '';
    }

    const trackPath = path.join(baseTracksDir, trackId);
    
    // Ensure the resolved path is still within the tracks directory
    const relative = path.relative(baseTracksDir, trackPath);
    const isInside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);

    if (!isInside && trackId !== '') {
      console.error(`[ERROR] [ContextInjectionService] Isolation breach attempt detected (out-of-bounds): ${trackId}`);
      return '';
    }

    if (!this.fs.exists(trackPath)) {
      return '';
    }

    const contextParts: string[] = [`# Context for Track: ${trackId}`];

    // 1. Always inject Product Vision (product.md) from the root if it exists
    const productPath = path.join(this.rootDir, '.meridian/product.md');
    if (this.fs.exists(productPath)) {
      const content = this.fs.readFile(productPath);
      contextParts.push(`\n## Product Vision\n\n${content}`);
    }

    // 2. Inject Track Files
    const files = this.fs.readDirectory(trackPath);

    for (const fileName of files) {
      const fullPath = path.join(trackPath, fileName);
      
      if (this.fs.isDirectory(fullPath)) {
        continue;
      }

      if (this.isForbidden(fullPath)) {
        continue;
      }

      // Only inject markdown files by default for context clarity
      if (fileName.endsWith('.md')) {
        const content = this.fs.readFile(fullPath);
        contextParts.push(`\n## File: ${fileName}\n\n${content}`);
      }
    }

    return contextParts.join('\n');
  }
}
