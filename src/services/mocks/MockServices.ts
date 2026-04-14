import { IFileSystem, IShell } from '../interfaces/ICoreServices';

export class MockFileSystem implements IFileSystem {
  private files: Record<string, string> = {};
  private directories: Set<string> = new Set();

  readFile(path: string): string {
    if (!this.files[path]) throw new Error(`File not found: ${path}`);
    return this.files[path];
  }

  writeFile(path: string, content: string): void {
    this.files[path] = content;
  }

  deleteFile(path: string): void {
    delete this.files[path];
  }

  exists(path: string): boolean {
    return !!this.files[path] || this.directories.has(path);
  }

  readDirectory(path: string): string[] {
    return Array.from(this.directories)
      .filter(dir => dir.startsWith(path) && dir !== path)
      .map(dir => dir.replace(path, '').split('/')[1])
      .concat(Object.keys(this.files).filter(f => f.startsWith(path)).map(f => f.replace(path, '').split('/')[1]))
      .filter((v, i, a) => v && a.indexOf(v) === i);
  }

  isDirectory(path: string): boolean {
    return this.directories.has(path);
  }

  mkdir(path: string): void {
    this.directories.add(path);
  }

  // Helper for tests
  __setupFile(path: string, content: string) {
    this.files[path] = content;
  }
}

export class MockShell implements IShell {
  private responses: Record<string, { stdout: string; stderr: string; exitCode: number }> = {};

  async execute(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.responses[command] || { stdout: '', stderr: '', exitCode: 0 };
  }

  // Helper for tests
  __setupResponse(command: string, response: { stdout: string; stderr: string; exitCode: number }) {
    this.responses[command] = response;
  }
}
