import { IFileSystem } from '../interfaces/ICoreServices';

export class MockFileSystem implements IFileSystem {
  private files: Map<string, string> = new Map();
  private directories: Set<string> = new Set();

  readFile(path: string): string {
    if (this.files.has(path)) {
      return this.files.get(path)!;
    }
    throw new Error(`File not found: ${path}`);
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  deleteFile(path: string): void {
    this.files.delete(path);
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.directories.has(path);
  }

  mkdir(path: string): void {
    this.directories.add(path);
  }

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

  isDirectory(path: string): boolean {
    return this.directories.has(path);
  }
}
