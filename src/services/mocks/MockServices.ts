import { IFileSystem, IShell } from '../interfaces/ICoreServices';

export class MockFileSystem implements IFileSystem {
  private files: Record<string, string> = {};
  private directories: Set<string> = new Set();

  // skipcq: JS-0105
  readFile(path: string): string {
    if (!this.files[path]) throw new Error(`File not found: ${path}`);
    return this.files[path];
  }

  // skipcq: JS-0105
  writeFile(path: string, content: string): void {
    this.files[path] = content;
  }

  // skipcq: JS-0105
  deleteFile(path: string): void {
    (this.files as any)[path] = undefined;
  }

  // skipcq: JS-0105
  exists(path: string): boolean {
    return this.files[path] !== undefined || this.directories.has(path);
  }

  // skipcq: JS-0105
  readDirectory(path: string): string[] {
    return Array.from(this.directories)
      .filter(dir => dir.startsWith(path) && dir !== path)
      .map(dir => dir.replace(path, '').split('/')[1])
      .concat(Object.keys(this.files).filter(f => f.startsWith(path)).map(f => f.replace(path, '').split('/')[1]))
      .filter((v, i, a) => v && a.indexOf(v) === i);
  }

  // skipcq: JS-0105
  isDirectory(path: string): boolean {
    return this.directories.has(path);
  }

  // skipcq: JS-0105
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

  // skipcq: JS-0105
  execute(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return Promise.resolve(this.responses[command] || { stdout: '', stderr: '', exitCode: 0 });
  }

  // Helper for tests
  // skipcq: JS-0105
  __setupResponse(command: string, response: { stdout: string; stderr: string; exitCode: number }) {
    this.responses[command] = response;
  }
}
