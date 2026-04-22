import { IFileSystem } from '../interfaces/ICoreServices';

/**
 * Mock implementation of IFileSystem for testing.
 */
export class MockFileSystem implements IFileSystem {
  private readonly files: Map<string, string> = new Map();
  private readonly directories: Set<string> = new Set();

  /**
   * Reads a file from the mock filesystem.
   */
  readFile(path: string): string {
    const content = this.files.get(path);
    if (content !== undefined) {
      return content;
    }
    throw new Error(`File not found: ${path}`);
  }

  /**
   * Writes a file to the mock filesystem.
   */
  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  /**
   * Appends content to an existing file or creates a new one.
   */
  appendFile(path: string, content: string): void {
    const existing = this.files.get(path) || '';
    this.files.set(path, existing + content);
  }

  /**
   * Deletes a file from the mock filesystem.
   */
  deleteFile(path: string): void {
    this.files.delete(path);
  }

  /**
   * Checks if a file or directory exists.
   */
  exists(path: string): boolean {
    return this.files.has(path) || this.directories.has(path);
  }

  /**
   * Lists contents of a directory.
   */
  readDirectory(path: string): string[] {
    const results: string[] = [];
    const normalizedPath = path.endsWith('/') ? path : `${path}/`;
    
    for (const filePath of this.files.keys()) {
        if (filePath.startsWith(normalizedPath)) {
            const remaining = filePath.slice(normalizedPath.length);
            if (!remaining.includes('/')) {
                results.push(remaining);
            }
        }
    }

    for (const dirPath of this.directories) {
        if (dirPath.startsWith(normalizedPath) && dirPath !== normalizedPath) {
            const remaining = dirPath.slice(normalizedPath.length);
            if (!remaining.includes('/')) {
                results.push(remaining);
            }
        }
    }

    return results;
  }

  /**
   * Checks if a path is a directory.
   */
  isDirectory(path: string): boolean {
    return this.directories.has(path);
  }

  /**
   * Creates a directory in the mock filesystem.
   */
  mkdir(path: string): void {
    this.directories.add(path);
  }

  /**
   * Helper for tests to setup file content.
   */
  __setupFile(path: string, content: string) {
    this.files.set(path, content);
  }
}
