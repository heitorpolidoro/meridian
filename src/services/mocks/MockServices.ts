import { IFileSystem, IShell } from '../interfaces/ICoreServices';

export class MockFileSystem implements IFileSystem {
  private files: Map<string, string> = new Map();
  private directories: Set<string> = new Set();

  readFile(path: string): string {
    const content = this.files.get(path);
    if (content !== undefined) {
      return content;
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

  mkdir(path: string): void {
    this.directories.add(path);
  }

  // Helper for tests
  __setupFile(path: string, content: string) {
    this.files.set(path, content);
  }
}

export class MockShell implements IShell {
  private responses: Map<string, { stdout: string; stderr: string; exitCode: number }> = new Map();

  /**
   * Executes a mock shell command and returns the predefined response.
   */
  execute(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const response = this.responses.get(command);
    if (response) {
      return Promise.resolve(response);
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  }

  // Helper for tests
  __setupResponse(command: string, response: { stdout: string; stderr: string; exitCode: number }) {
    this.responses.set(command, response);
  }
}
