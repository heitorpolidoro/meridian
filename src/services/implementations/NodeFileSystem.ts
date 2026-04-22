import fs from 'node:fs';
import { IFileSystem } from '../interfaces/ICoreServices';

/**
 * Production implementation of IFileSystem using Node.js 'fs' module.
 */
export class NodeFileSystem implements IFileSystem {
  /**
   * Reads a file synchronously using utf8 encoding.
   */
  // skipcq: JS-0105
  readFile(path: string): string {
    return fs.readFileSync(path, 'utf8');
  }

  /**
   * Writes a file synchronously using utf8 encoding.
   */
  // skipcq: JS-0105
  writeFile(path: string, content: string): void {
    fs.writeFileSync(path, content, 'utf8');
  }

  /**
   * Appends content to a file synchronously.
   */
  // skipcq: JS-0105
  appendFile(path: string, content: string): void {
    fs.appendFileSync(path, content, 'utf8');
  }

  /**
   * Deletes a file if it exists.
   */
  // skipcq: JS-0105
  deleteFile(path: string): void {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
    }
  }

  /**
   * Checks for file or directory existence.
   */
  // skipcq: JS-0105
  exists(path: string): boolean {
    return fs.existsSync(path);
  }

  /**
   * Lists directory contents.
   */
  // skipcq: JS-0105
  readDirectory(path: string): string[] {
    return fs.readdirSync(path);
  }

  /**
   * Synchronously checks if a path is a directory.
   */
  // skipcq: JS-0105
  isDirectory(path: string): boolean {
    return fs.statSync(path).isDirectory();
  }

  /**
   * Creates a directory recursively.
   */
  // skipcq: JS-0105
  mkdir(path: string): void {
    fs.mkdirSync(path, { recursive: true });
  }
}
